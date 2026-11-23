#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = path.join(root, 'memory', 'review-index.json');

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function normalizeRelativePath(input) {
  return path.relative(root, path.resolve(root, input)).split(path.sep).join('/');
}

function listScopeFiles(scopePath) {
  const absolutePath = path.resolve(root, scopePath);
  if (!existsSync(absolutePath)) return [{ absolutePath, relativePath: normalizeRelativePath(scopePath), missing: true }];
  const entry = lstatSync(absolutePath);
  if (entry.isSymbolicLink()) throw new Error(`scope path must not be a symbolic link: ${scopePath}`);
  if (entry.isFile()) return [{ absolutePath, relativePath: normalizeRelativePath(scopePath), missing: false }];
  if (!entry.isDirectory()) throw new Error(`unsupported scope path type: ${scopePath}`);
  const files = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of entries) {
      if (child.isSymbolicLink()) throw new Error(`scope directory contains a symbolic link: ${path.join(directory, child.name)}`);
      const childPath = path.join(directory, child.name);
      if (child.isDirectory()) visit(childPath);
      else if (child.isFile()) files.push({ absolutePath: childPath, relativePath: normalizeRelativePath(childPath), missing: false });
    }
  };
  visit(absolutePath);
  return files;
}

function fileSha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function computeFingerprint(scopePaths) {
  const files = scopePaths.flatMap(listScopeFiles).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const unique = new Map(files.map((file) => [file.relativePath, file]));
  const digest = createHash('sha256');
  const fileHashes = {};
  for (const file of unique.values()) {
    digest.update(`${file.relativePath}\n`);
    if (file.missing) {
      digest.update('MISSING\n');
      fileHashes[file.relativePath] = 'MISSING';
      continue;
    }
    const hash = fileSha256(file.absolutePath);
    digest.update(`${hash}\n`);
    fileHashes[file.relativePath] = hash;
  }
  return { scopeFingerprint: digest.digest('hex'), fileHashes, fileCount: unique.size };
}

function statePath(input) {
  if (!input) throw new Error('state file path is required');
  const absolute = path.resolve(root, input);
  if (!normalizeRelativePath(absolute).startsWith('memory/')) throw new Error(`state file must be under memory/: ${input}`);
  return { absolute, relative: normalizeRelativePath(absolute) };
}

function inspect(input) {
  const { absolute, relative } = statePath(input);
  const state = readJson(absolute);
  const index = readJson(indexPath);
  const target = index.targets?.[relative];
  const required = index.state?.requiredFields ?? [];
  const missing = required.filter((field) => state[field] === undefined);
  const errors = [];
  if (state.schemaVersion !== index.state?.requiredSchemaVersion) errors.push(`schemaVersion must be ${index.state?.requiredSchemaVersion}`);
  if (missing.length) errors.push(`missing fields: ${missing.join(', ')}`);
  if (!target) errors.push(`target is not registered in ${indexPath}`);
  if (target && state.target !== target.target) errors.push('target mismatch');
  if (target && state.coverageProfile !== target.coverageProfile) errors.push('coverageProfile mismatch');
  const declared = Array.isArray(state.scopePaths) ? state.scopePaths : [];
  const configured = Array.isArray(target?.scopePaths) ? target.scopePaths : [];
  if (JSON.stringify([...declared].sort()) !== JSON.stringify([...configured].sort())) errors.push('scopePaths do not match review-index target config');
  const current = computeFingerprint(declared);
  const fingerprintMatches = state.scopeFingerprint === current.scopeFingerprint;
  if (!fingerprintMatches) errors.push(`scopeFingerprint mismatch: state=${state.scopeFingerprint} current=${current.scopeFingerprint}`);
  const changedFiles = Object.entries(current.fileHashes).filter(([name, hash]) => state.fileHashes?.[name] !== hash).map(([name]) => name);
  if (changedFiles.length) errors.push(`fileHashes mismatch: ${changedFiles.join(', ')}`);
  const targetAbsolute = path.resolve(root, target?.target ?? state.target ?? '');
  const sourceSha256 = existsSync(targetAbsolute) ? fileSha256(targetAbsolute) : null;
  const sourceMatches = state.sourceSha256 === sourceSha256;
  if (!sourceMatches) errors.push(`sourceSha256 mismatch: state=${state.sourceSha256} current=${sourceSha256}`);
  return {
    statePath: relative,
    target: state.target,
    coverageProfile: state.coverageProfile,
    status: state.status,
    round: state.round,
    consecutiveNoLeakRounds: state.consecutiveNoLeakRounds,
    scopeFingerprint: { declared: state.scopeFingerprint, current: current.scopeFingerprint, fileCount: current.fileCount, matches: fingerprintMatches },
    sourceSha256: { declared: state.sourceSha256, current: sourceSha256, matches: sourceMatches },
    fileCount: current.fileCount,
    errors,
    fileHashes: current.fileHashes,
  };
}

const [command, ...inputs] = process.argv.slice(2);
if (!['check', 'fingerprint'].includes(command) || inputs.length === 0) {
  console.error('usage: node scripts/review-state.mjs <check|fingerprint> <state-file...>');
  process.exit(1);
}
let failed = false;
for (const input of inputs) {
  try {
    const result = inspect(input);
    if (command === 'fingerprint') {
      console.log(JSON.stringify({ statePath: result.statePath, scopeFingerprint: result.scopeFingerprint.current, sourceSha256: result.sourceSha256.current, fileCount: result.fileCount, fileHashes: result.fileHashes }, null, 2));
      continue;
    }
    if (result.errors.length) {
      failed = true;
      console.error(`${result.statePath}: FAIL`);
      for (const error of result.errors) console.error(`- ${error}`);
      continue;
    }
    console.log(`${result.statePath}: OK profile=${result.coverageProfile} status=${result.status} round=${result.round} rounds=${result.consecutiveNoLeakRounds} files=${result.fileCount}`);
  } catch (error) {
    failed = true;
    console.error(`${input}: ERROR ${error instanceof Error ? error.message : String(error)}`);
  }
}
process.exit(failed ? 2 : 0);
