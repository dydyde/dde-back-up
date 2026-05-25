#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ensureEnvFiles } = require('./ensure-env-files.cjs');

const projectRoot = process.cwd();
const srcRoot = path.join(projectRoot, 'src');
const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const testFilePattern = /\.(spec|test)\.ts$/;
const perfTestDir = 'src/tests/perf/';
const testBedPattern = /\bTestBed\b/;
const domPattern = /\b(window|document|navigator|HTMLElement|HTML[A-Za-z]+Element|matchMedia|requestAnimationFrame|cancelAnimationFrame|ResizeObserver|MutationObserver|IntersectionObserver|CustomEvent|EventTarget)\b/;
const componentPathPattern = /\/components\/|\.component\.(spec|test)\.ts$/;
const componentContentPattern = /\b(createComponent\s*\(|ComponentFixture\s*<|TestBed\.createComponent\s*\()/;

const LANE_NAMES = {
  nodeMinimal: 'lane_node_minimal',
  browserMinimal: 'lane_browser_minimal',
  testbedService: 'lane_testbed_service',
  testbedComponent: 'lane_testbed_component',
};

const ALL_LANES = [
  LANE_NAMES.nodeMinimal,
  LANE_NAMES.browserMinimal,
  LANE_NAMES.testbedService,
  LANE_NAMES.testbedComponent,
];

const laneConfig = {
  [LANE_NAMES.nodeMinimal]: {
    config: 'vitest.minimal-node.config.mts',
    defaultIsolate: false,
    forceIsolateFiles: [
      'src/app/core/services/app-auth-coordinator.service.spec.ts',
    ],
  },
  [LANE_NAMES.browserMinimal]: {
    config: 'vitest.minimal.config.mts',
    defaultIsolate: false,
    forceIsolateFiles: [],
  },
  [LANE_NAMES.testbedService]: {
    config: 'vitest.config.mts',
    defaultIsolate: false,
    forceIsolateFiles: [
      'src/app/features/flow/services/flow-overview.service.spec.ts',
    ],
  },
  [LANE_NAMES.testbedComponent]: {
    config: 'vitest.config.mts',
    defaultIsolate: false,
    extraArgs: ['--fileParallelism=false'],
    forceIsolateFiles: [],
  },
};

const DEFAULT_DURATION_BASELINE = 'scripts/test-duration-baseline.json';
const DEFAULT_QUARANTINE = 'scripts/test-quarantine.json';
const DEFAULT_STRATEGY_LOCAL = 'mod';
const DEFAULT_STRATEGY_CI = 'weighted';
const DEFAULT_FILE_ESTIMATE_MS = 1000;
const FORCED_ISOLATE_FILE_OVERHEAD_MS = 3000;
const DEFAULT_BASELINE_MAX_AGE_HOURS = 24;
const DEFAULT_MIN_FILE_ESTIMATES = 20;
const DEFAULT_TIMING_OUT_DIR = 'test-results';
const DEFAULT_VITEST_JSON_OUT_DIR = 'test-results/vitest-reports';
const MAX_LIST_PREVIEW = 30;

const toPosix = (value) => value.split(path.sep).join('/');

const normalizeRelativePath = (filePath) => {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  return toPosix(path.relative(projectRoot, abs));
};

const parsePositiveInt = (value) => {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const parsePositiveNumber = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const parseBooleanOption = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
};

const parseMaxProcsOption = (value) => {
  if (!value || value === 'auto') return 'auto';
  const n = parsePositiveInt(value);
  if (!n) {
    throw new Error(`Invalid --max-procs value "${value}", expected auto|positive-int`);
  }
  return n;
};

const parseStrategy = (value) => {
  if (!value) return undefined;
  if (value !== 'mod' && value !== 'weighted') {
    throw new Error(`Invalid --strategy value "${value}", expected mod|weighted`);
  }
  return value;
};

const parsePathList = (value) => {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

ensureEnvFiles();

const sanitizeFilePart = (value) => String(value)
  .replace(/[^a-zA-Z0-9._-]+/g, '-')
  .replace(/^-+|-+$/g, '');

const toProjectPathOrAbsolute = (absolutePath) => {
  const relative = toPosix(path.relative(projectRoot, absolutePath));
  return relative.startsWith('..') ? absolutePath : relative;
};

function collectTestFiles(rootDir) {
  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      if (entry.isFile() && testFilePattern.test(entry.name)) {
        const relativePath = toPosix(path.relative(projectRoot, absolutePath));
        if (relativePath.startsWith(perfTestDir)) {
          continue;
        }
        files.push(relativePath);
      }
    }
  }

  files.sort();
  return files;
}

function parseShard(value) {
  const m = value.match(/^(\d+)\/(\d+)$/);
  if (!m) {
    throw new Error(`Invalid --shard value "${value}", expected i/n`);
  }

  const index = Number.parseInt(m[1], 10);
  const total = Number.parseInt(m[2], 10);
  if (!Number.isFinite(index) || !Number.isFinite(total) || index < 1 || total < 1 || index > total) {
    throw new Error(`Invalid --shard value "${value}", index must satisfy 1 <= i <= n`);
  }

  return { index, total, value: `${index}/${total}` };
}

function summarizeList(list) {
  if (list.length <= MAX_LIST_PREVIEW) {
    return list.join('\n');
  }
  const preview = list.slice(0, MAX_LIST_PREVIEW).join('\n');
  return `${preview}\n... (+${list.length - MAX_LIST_PREVIEW} more)`;
}

function parseArgs(argv) {
  const modeFromEnv = process.env.TEST_MODE === 'ci' ? 'ci' : 'local';
  let mode = modeFromEnv;
  let shard = null;
  let maxProcsOption;
  let strategy;
  let includeQuarantine;
  let quarantinePath;
  let overridesPath;
  let timingOut;
  let durationBaselinePath;
  const timingInputPaths = [];
  let vitestJsonOutDir;
  let enableLpt = process.env.TEST_LPT_SCHEDULER === '1';
  let lptRequireFreshBaseline = parseBooleanOption(process.env.TEST_LPT_REQUIRE_FRESH_BASELINE);
  let baselineMaxAgeHours = parsePositiveNumber(process.env.TEST_BASELINE_MAX_AGE_HOURS);
  let minFileEstimates = parsePositiveInt(process.env.TEST_MIN_FILE_ESTIMATES);
  const selectedLanes = new Set();
  const passthrough = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--') {
      passthrough.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length);
      continue;
    }
    if (arg === '--mode') {
      mode = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--shard=')) {
      shard = parseShard(arg.slice('--shard='.length));
      continue;
    }
    if (arg === '--shard') {
      shard = parseShard(argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg.startsWith('--max-procs=')) {
      maxProcsOption = parseMaxProcsOption(arg.slice('--max-procs='.length));
      continue;
    }
    if (arg === '--max-procs') {
      maxProcsOption = parseMaxProcsOption(argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg.startsWith('--strategy=')) {
      strategy = parseStrategy(arg.slice('--strategy='.length));
      continue;
    }
    if (arg === '--strategy') {
      strategy = parseStrategy(argv[i + 1]);
      i += 1;
      continue;
    }

    if (arg === '--include-quarantine') {
      includeQuarantine = true;
      continue;
    }
    if (arg === '--exclude-quarantine') {
      includeQuarantine = false;
      continue;
    }

    if (arg.startsWith('--quarantine=')) {
      quarantinePath = arg.slice('--quarantine='.length);
      continue;
    }
    if (arg === '--quarantine') {
      quarantinePath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--overrides=')) {
      overridesPath = arg.slice('--overrides='.length);
      continue;
    }
    if (arg === '--overrides') {
      overridesPath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--lane=')) {
      arg.slice('--lane='.length)
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .forEach((name) => selectedLanes.add(name));
      continue;
    }
    if (arg === '--lane') {
      argv[i + 1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .forEach((name) => selectedLanes.add(name));
      i += 1;
      continue;
    }

    if (arg.startsWith('--timing-out=')) {
      timingOut = arg.slice('--timing-out='.length);
      continue;
    }
    if (arg === '--timing-out') {
      timingOut = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--timing-in=')) {
      timingInputPaths.push(...parsePathList(arg.slice('--timing-in='.length)));
      continue;
    }
    if (arg === '--timing-in') {
      timingInputPaths.push(...parsePathList(argv[i + 1]));
      i += 1;
      continue;
    }

    if (arg.startsWith('--vitest-json-out-dir=')) {
      vitestJsonOutDir = arg.slice('--vitest-json-out-dir='.length).trim();
      continue;
    }
    if (arg === '--vitest-json-out-dir') {
      vitestJsonOutDir = String(argv[i + 1] ?? '').trim();
      i += 1;
      continue;
    }

    if (arg.startsWith('--baseline=')) {
      durationBaselinePath = arg.slice('--baseline='.length);
      continue;
    }
    if (arg === '--baseline') {
      durationBaselinePath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--duration-baseline=')) {
      durationBaselinePath = arg.slice('--duration-baseline='.length);
      continue;
    }
    if (arg === '--duration-baseline') {
      durationBaselinePath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--lpt') {
      enableLpt = true;
      continue;
    }

    if (arg === '--no-lpt') {
      enableLpt = false;
      continue;
    }

    if (arg === '--lpt-require-fresh-baseline') {
      lptRequireFreshBaseline = true;
      continue;
    }

    if (arg === '--no-lpt-require-fresh-baseline') {
      lptRequireFreshBaseline = false;
      continue;
    }

    if (arg.startsWith('--baseline-max-age-hours=')) {
      const parsed = parsePositiveNumber(arg.slice('--baseline-max-age-hours='.length));
      if (!parsed) {
        throw new Error(`Invalid --baseline-max-age-hours value "${arg.slice('--baseline-max-age-hours='.length)}", expected positive-number`);
      }
      baselineMaxAgeHours = parsed;
      continue;
    }

    if (arg === '--baseline-max-age-hours') {
      const parsed = parsePositiveNumber(argv[i + 1]);
      if (!parsed) {
        throw new Error(`Invalid --baseline-max-age-hours value "${argv[i + 1]}", expected positive-number`);
      }
      baselineMaxAgeHours = parsed;
      i += 1;
      continue;
    }

    if (arg.startsWith('--min-file-estimates=')) {
      const parsed = parsePositiveInt(arg.slice('--min-file-estimates='.length));
      if (!parsed) {
        throw new Error(`Invalid --min-file-estimates value "${arg.slice('--min-file-estimates='.length)}", expected positive-int`);
      }
      minFileEstimates = parsed;
      continue;
    }

    if (arg === '--min-file-estimates') {
      const parsed = parsePositiveInt(argv[i + 1]);
      if (!parsed) {
        throw new Error(`Invalid --min-file-estimates value "${argv[i + 1]}", expected positive-int`);
      }
      minFileEstimates = parsed;
      i += 1;
      continue;
    }

    passthrough.push(arg);
  }

  if (mode !== 'local' && mode !== 'ci') {
    throw new Error(`Invalid --mode value "${mode}", expected local|ci`);
  }

  if (!shard && mode === 'ci') {
    const shardIndex = parsePositiveInt(process.env.TEST_SHARD_INDEX);
    const shardTotal = parsePositiveInt(process.env.TEST_SHARDS);
    if (shardIndex && shardTotal) {
      shard = parseShard(`${shardIndex}/${shardTotal}`);
    }
  }

  if (maxProcsOption === undefined) {
    maxProcsOption = parseMaxProcsOption(process.env.TEST_MAX_PROCS || 'auto');
  }

  if (!strategy) {
    strategy = parseStrategy(process.env.TEST_SHARD_STRATEGY)
      ?? (mode === 'ci' ? DEFAULT_STRATEGY_CI : DEFAULT_STRATEGY_LOCAL);
  }

  if (!overridesPath && process.env.TEST_LANE_OVERRIDES) {
    overridesPath = process.env.TEST_LANE_OVERRIDES;
  }

  if (!timingOut && process.env.TEST_TIMING_FILE) {
    timingOut = process.env.TEST_TIMING_FILE;
  }

  if (timingInputPaths.length === 0 && process.env.TEST_TIMING_IN) {
    timingInputPaths.push(...parsePathList(process.env.TEST_TIMING_IN));
  }

  if (!vitestJsonOutDir && process.env.TEST_VITEST_JSON_OUT_DIR) {
    vitestJsonOutDir = process.env.TEST_VITEST_JSON_OUT_DIR.trim();
  }

  if (!durationBaselinePath) {
    durationBaselinePath = process.env.TEST_DURATION_BASELINE || DEFAULT_DURATION_BASELINE;
  }

  if (!quarantinePath) {
    quarantinePath = process.env.TEST_QUARANTINE_FILE || DEFAULT_QUARANTINE;
  }

  const resolvedSelectedLanes = selectedLanes.size > 0
    ? [...selectedLanes].sort()
    : [...ALL_LANES];

  for (const lane of resolvedSelectedLanes) {
    if (!ALL_LANES.includes(lane)) {
      throw new Error(`Invalid lane "${lane}", expected one of: ${ALL_LANES.join(', ')}`);
    }
  }

  if (!timingOut && enableLpt) {
    const shardLabel = shard?.value
      ? sanitizeFilePart(shard.value)
      : 'all';
    const laneKey = resolvedSelectedLanes.length === ALL_LANES.length
      ? 'all-lanes'
      : resolvedSelectedLanes.join('__');
    timingOut = path.join(
      DEFAULT_TIMING_OUT_DIR,
      `vitest-${sanitizeFilePart(mode)}-${sanitizeFilePart(laneKey)}-shard-${shardLabel}.json`
    );
  }

  if (timingInputPaths.length === 0) {
    const defaultTimingInputs = [];
    if (durationBaselinePath) {
      defaultTimingInputs.push(durationBaselinePath);
    }
    if (timingOut) {
      defaultTimingInputs.push(timingOut);
    }
    timingInputPaths.push(...new Set(defaultTimingInputs));
  }

  if (!vitestJsonOutDir && enableLpt) {
    vitestJsonOutDir = DEFAULT_VITEST_JSON_OUT_DIR;
  }

  if (lptRequireFreshBaseline === undefined) {
    lptRequireFreshBaseline = true;
  }
  if (!baselineMaxAgeHours) {
    baselineMaxAgeHours = DEFAULT_BASELINE_MAX_AGE_HOURS;
  }
  if (!minFileEstimates) {
    minFileEstimates = DEFAULT_MIN_FILE_ESTIMATES;
  }

  if (includeQuarantine === undefined) {
    includeQuarantine = process.env.TEST_INCLUDE_QUARANTINE === '1' || mode === 'ci';
  }

  return {
    mode,
    shard,
    maxProcsOption,
    strategy,
    includeQuarantine,
    quarantinePath,
    overridesPath,
    timingOut,
    timingInputPaths,
    vitestJsonOutDir,
    durationBaselinePath,
    enableLpt,
    lptRequireFreshBaseline,
    baselineMaxAgeHours,
    minFileEstimates,
    selectedLanes: resolvedSelectedLanes,
    passthrough,
  };
}

function toAbsolutePath(relativePath) {
  return path.isAbsolute(relativePath)
    ? relativePath
    : path.join(projectRoot, relativePath);
}

function loadOverrides(overridesPath) {
  if (!overridesPath) return {};
  const absolutePath = toAbsolutePath(overridesPath);

  const raw = fs.readFileSync(absolutePath, 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Lane overrides must be a JSON object: ${overridesPath}`);
  }

  for (const [file, lane] of Object.entries(parsed)) {
    if (!ALL_LANES.includes(lane)) {
      throw new Error(`Invalid override lane for ${file}: ${lane}`);
    }
  }

  return parsed;
}

function loadQuarantine(quarantinePath) {
  const result = {
    path: quarantinePath,
    exists: false,
    files: new Set(),
  };

  const absolutePath = toAbsolutePath(quarantinePath);
  if (!fs.existsSync(absolutePath)) {
    return result;
  }

  const raw = fs.readFileSync(absolutePath, 'utf8');
  const parsed = JSON.parse(raw);
  result.exists = true;

  const records = [];
  if (Array.isArray(parsed)) {
    records.push(...parsed);
  }
  if (Array.isArray(parsed?.files)) {
    records.push(...parsed.files);
  }
  if (Array.isArray(parsed?.entries)) {
    for (const entry of parsed.entries) {
      if (!entry || typeof entry !== 'object') continue;
      const maybeFile = entry.file ?? entry.path ?? entry.name;
      if (typeof maybeFile === 'string' && maybeFile.trim()) {
        records.push(maybeFile);
      }
    }
  }

  records
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => normalizeRelativePath(value))
    .forEach((value) => result.files.add(value));

  return result;
}

function classifyFile(file, content, overrides) {
  if (overrides[file]) {
    return overrides[file];
  }

  if (testBedPattern.test(content)) {
    if (
      componentPathPattern.test(file)
      || componentContentPattern.test(content)
      || file.endsWith('src/app.component.spec.ts')
      || file.endsWith('src/workspace-shell.component.spec.ts')
      || file.endsWith('src/app.routes.spec.ts')
    ) {
      return LANE_NAMES.testbedComponent;
    }
    return LANE_NAMES.testbedService;
  }

  if (file.startsWith('src/tests/integration/')) {
    return LANE_NAMES.browserMinimal;
  }

  if (domPattern.test(content)) {
    return LANE_NAMES.browserMinimal;
  }

  return LANE_NAMES.nodeMinimal;
}

function classifyAllFiles(files, overrides) {
  const laneByFile = new Map();
  for (const relativeFile of files) {
    const absoluteFile = path.join(projectRoot, relativeFile);
    const content = fs.readFileSync(absoluteFile, 'utf8');
    const lane = classifyFile(relativeFile, content, overrides);
    laneByFile.set(relativeFile, lane);
  }
  return laneByFile;
}

function buildBuckets(files, laneByFile) {
  const lanes = {
    [LANE_NAMES.nodeMinimal]: [],
    [LANE_NAMES.browserMinimal]: [],
    [LANE_NAMES.testbedService]: [],
    [LANE_NAMES.testbedComponent]: [],
  };

  for (const file of files) {
    const lane = laneByFile.get(file);
    if (!lane) {
      throw new Error(`Missing lane classification for file: ${file}`);
    }
    lanes[lane].push(file);
  }

  return lanes;
}

function validatePartition(allFiles, lanes) {
  const allSet = new Set(allFiles);
  const laneNames = Object.keys(lanes);

  for (let i = 0; i < laneNames.length; i += 1) {
    const aName = laneNames[i];
    const aSet = new Set(lanes[aName]);

    for (let j = i + 1; j < laneNames.length; j += 1) {
      const bName = laneNames[j];
      const overlap = lanes[bName].filter((file) => aSet.has(file));
      if (overlap.length > 0) {
        throw new Error(
          [
            `Lane overlap detected: ${aName} ∩ ${bName}`,
            summarizeList(overlap),
          ].join('\n')
        );
      }
    }
  }

  const union = new Set();
  for (const laneFiles of Object.values(lanes)) {
    for (const file of laneFiles) {
      union.add(file);
    }
  }

  const missing = allFiles.filter((file) => !union.has(file));
  const extra = [...union].filter((file) => !allSet.has(file));

  if (missing.length > 0 || extra.length > 0) {
    const lines = ['Lane partition validation failed.'];
    if (missing.length > 0) {
      lines.push(`Missing files (${missing.length}):`);
      lines.push(summarizeList(missing));
    }
    if (extra.length > 0) {
      lines.push(`Unexpected files (${extra.length}):`);
      lines.push(summarizeList(extra));
    }
    throw new Error(lines.join('\n'));
  }
}

function filterByQuarantine(files, quarantineSet, includeQuarantine) {
  if (includeQuarantine || quarantineSet.size === 0) {
    return {
      effectiveFiles: [...files],
      excludedFiles: [],
    };
  }

  const effectiveFiles = [];
  const excludedFiles = [];

  for (const file of files) {
    if (quarantineSet.has(file)) {
      excludedFiles.push(file);
    } else {
      effectiveFiles.push(file);
    }
  }

  return { effectiveFiles, excludedFiles };
}

function applyModuloShard(files, shard) {
  if (!shard) return files;
  return files.filter((_file, index) => index % shard.total === (shard.index - 1));
}

function applyWeightedShard(files, shard, estimateFile) {
  if (!shard) return files;

  const bins = Array.from({ length: shard.total }, (_value, index) => ({
    index,
    totalWeight: 0,
    files: [],
  }));

  const ranked = files
    .map((file) => ({
      file,
      estimateMs: Math.max(1, Math.floor(estimateFile(file))),
    }))
    .sort((a, b) => {
      if (b.estimateMs !== a.estimateMs) return b.estimateMs - a.estimateMs;
      return a.file.localeCompare(b.file);
    });

  for (const entry of ranked) {
    bins.sort((a, b) => {
      if (a.totalWeight !== b.totalWeight) return a.totalWeight - b.totalWeight;
      return a.index - b.index;
    });

    bins[0].files.push(entry.file);
    bins[0].totalWeight += entry.estimateMs;
  }

  bins.forEach((bin) => bin.files.sort());

  return bins[shard.index - 1].files;
}

function applyShard(files, shard, strategy, estimateFile) {
  if (!shard) return files;
  if (strategy === 'weighted') {
    return applyWeightedShard(files, shard, estimateFile);
  }
  return applyModuloShard(files, shard);
}

function hasOption(passthrough, names) {
  return passthrough.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

function isIsolateArg(arg) {
  return arg === '--isolate'
    || arg === '--no-isolate'
    || arg.startsWith('--isolate=')
    || arg.startsWith('--no-isolate=');
}

function buildVitestJsonReportPath(vitestJsonOutDir, task) {
  if (!vitestJsonOutDir) return null;
  const absoluteDir = path.isAbsolute(vitestJsonOutDir)
    ? vitestJsonOutDir
    : path.join(projectRoot, vitestJsonOutDir);
  const safeMode = sanitizeFilePart(task.mode) || 'mode';
  const safeShard = sanitizeFilePart(task.shardLabel) || 'all';
  const safeLane = sanitizeFilePart(task.laneName) || 'lane';
  const safeSegment = sanitizeFilePart(task.segmentName) || 'segment';
  const safeOrder = String(task.order).padStart(2, '0');
  return path.join(absoluteDir, `vitest-report-${safeMode}-${safeShard}-${safeLane}-${safeSegment}-${safeOrder}.json`);
}

function buildVitestArgs(laneName, files, passthrough, forceIsolate, vitestJsonReportPath) {
  const lane = laneConfig[laneName];
  const args = ['vitest', 'run', '--config', lane.config];
  const lanePassthrough = forceIsolate === undefined
    ? passthrough
    : passthrough.filter((arg) => !isIsolateArg(arg));

  const hasIsolate = hasOption(lanePassthrough, ['--isolate', '--no-isolate']);
  if (forceIsolate === true) {
    args.push('--isolate');
  } else if (forceIsolate === false) {
    args.push('--no-isolate');
  } else if (!hasIsolate) {
    args.push(lane.defaultIsolate === false ? '--no-isolate' : '--isolate');
  }

  const hasMaxWorkers = hasOption(lanePassthrough, ['--maxWorkers']);
  if (!hasMaxWorkers) {
    args.push('--maxWorkers=1');
  }

  const hasReporter = hasOption(lanePassthrough, ['--reporter']);
  if (vitestJsonReportPath) {
    if (!hasReporter) {
      args.push('--reporter=default');
    }
    args.push('--reporter=json');
    args.push(`--outputFile=${vitestJsonReportPath}`);
  }

  if (lane.extraArgs) {
    args.push(...lane.extraArgs);
  }

  args.push(...lanePassthrough);
  args.push(...files);
  return args;
}

function spawnVitest(commandArgs) {
  return new Promise((resolve) => {
    const invokedAt = Date.now();
    let spawnedAt = invokedAt;

    // On Windows, spawning .cmd files (like npx.cmd) with stdio:'inherit' can
    // fail with EINVAL in Node.js v22+ when the parent's stdio is a pipe
    // (e.g. VS Code integrated terminal). Using shell:true routes through
    // cmd.exe and avoids the EINVAL error.
    const spawnOpts = {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    };
    if (process.platform === 'win32') {
      spawnOpts.shell = true;
    }

    const child = spawn(npxBin, commandArgs, spawnOpts);

    child.on('spawn', () => {
      spawnedAt = Date.now();
    });

    child.on('exit', (code, signal) => {
      const exitCode = signal ? 1 : (code ?? 1);
      resolve({
        exitCode,
        spawnOverheadMs: Math.max(0, spawnedAt - invokedAt),
      });
    });

    child.on('error', () => {
      resolve({
        exitCode: 1,
        spawnOverheadMs: Math.max(0, Date.now() - invokedAt),
      });
    });
  });
}

function buildLaneSegments(laneName, files) {
  const lane = laneConfig[laneName];
  const forcedIsolateSet = new Set(lane.forceIsolateFiles ?? []);
  const sharedFiles = [];
  const forcedIsolateFiles = [];

  for (const file of files) {
    if (forcedIsolateSet.has(file)) {
      forcedIsolateFiles.push(file);
    } else {
      sharedFiles.push(file);
    }
  }

  const segments = [];
  if (sharedFiles.length > 0) {
    segments.push({
      segmentName: 'shared',
      files: sharedFiles,
      forceIsolate: lane.defaultIsolate,
      segmentOrder: 0,
    });
  }

  if (forcedIsolateFiles.length > 0) {
    segments.push({
      segmentName: 'forced-isolate',
      files: forcedIsolateFiles,
      forceIsolate: true,
      segmentOrder: 1,
    });
  }

  return segments;
}

function loadDurationBaseline(durationBaselinePath) {
  const result = {
    path: durationBaselinePath,
    exists: false,
    schemaVersion: null,
    generatedAt: null,
    laneEstimates: new Map(),
    fileEstimates: new Map(),
    laneAverages: new Map(),
  };

  if (!durationBaselinePath) {
    return result;
  }

  const absolutePath = toAbsolutePath(durationBaselinePath);
  if (!fs.existsSync(absolutePath)) {
    return result;
  }

  const raw = fs.readFileSync(absolutePath, 'utf8');
  const parsed = JSON.parse(raw);
  result.exists = true;
  result.schemaVersion = Number.isFinite(parsed?.schemaVersion) ? parsed.schemaVersion : null;
  result.generatedAt = typeof parsed?.generatedAt === 'string' ? parsed.generatedAt : null;

  const registerEstimate = (map, key, value) => {
    if (!key) return;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return;
    map.set(String(key), Math.floor(n));
  };

  if (parsed && typeof parsed === 'object') {
    if (parsed.tasks && typeof parsed.tasks === 'object' && !Array.isArray(parsed.tasks)) {
      for (const [key, value] of Object.entries(parsed.tasks)) {
        registerEstimate(result.laneEstimates, key, value);
      }
    }

    if (parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)) {
      for (const [key, value] of Object.entries(parsed.files)) {
        registerEstimate(result.fileEstimates, normalizeRelativePath(key), value);
      }
    }

    if (parsed.laneAverages && typeof parsed.laneAverages === 'object' && !Array.isArray(parsed.laneAverages)) {
      for (const [key, value] of Object.entries(parsed.laneAverages)) {
        registerEstimate(result.laneAverages, key, value);
      }
    }

    if (Array.isArray(parsed.lanes)) {
      for (const lane of parsed.lanes) {
        if (!lane || typeof lane !== 'object' || typeof lane.laneName !== 'string') continue;

        if (Array.isArray(lane.segments) && lane.segments.length > 0) {
          for (const segment of lane.segments) {
            if (!segment || typeof segment !== 'object' || typeof segment.segmentName !== 'string') continue;
            registerEstimate(result.laneEstimates, `${lane.laneName}/${segment.segmentName}`, segment.durationMs);
          }
        }

        registerEstimate(result.laneEstimates, `${lane.laneName}/shared`, lane.durationMs);
      }
    }
  }

  return result;
}

function loadTimingInputs(inputPaths) {
  const result = {
    loadedPaths: [],
    fileEstimates: new Map(),
  };

  if (!inputPaths || inputPaths.length === 0) {
    return result;
  }

  const aggregates = new Map();
  const register = (file, value) => {
    const n = Number(value);
    if (!file || !Number.isFinite(n) || n <= 0) return;

    const normalized = normalizeRelativePath(file);
    if (normalized.startsWith('..')) return;

    const current = aggregates.get(normalized) ?? { sum: 0, count: 0 };
    current.sum += n;
    current.count += 1;
    aggregates.set(normalized, current);
  };

  for (const maybePath of inputPaths) {
    const absolutePath = toAbsolutePath(maybePath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    let parsed;
    try {
      const raw = fs.readFileSync(absolutePath, 'utf8');
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    result.loadedPaths.push(maybePath);

    if (parsed && typeof parsed === 'object') {
      if (parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)) {
        for (const [file, value] of Object.entries(parsed.files)) {
          register(file, value);
        }
      }

      if (parsed.fileDurations && typeof parsed.fileDurations === 'object' && !Array.isArray(parsed.fileDurations)) {
        for (const [file, value] of Object.entries(parsed.fileDurations)) {
          register(file, value);
        }
      }

      if (Array.isArray(parsed.testResults)) {
        for (const entry of parsed.testResults) {
          if (!entry || typeof entry !== 'object') continue;
          if (typeof entry.name !== 'string' || !entry.name.trim()) continue;
          const duration = Number(entry.duration)
            || (Number(entry.endTime) && Number(entry.startTime) ? Number(entry.endTime) - Number(entry.startTime) : 0);
          register(entry.name, duration);
        }
      }
    }
  }

  for (const [file, aggregate] of aggregates.entries()) {
    result.fileEstimates.set(file, Math.max(1, Math.floor(aggregate.sum / aggregate.count)));
  }

  return result;
}

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return undefined;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function collectTimingObservations(inputPaths) {
  const result = {
    loadedPaths: [],
    fileSamples: new Map(),
  };

  if (!inputPaths || inputPaths.length === 0) {
    return result;
  }

  const addSample = (file, value) => {
    const n = parsePositiveNumber(value);
    if (!file || !n) return;

    const normalized = normalizeRelativePath(file);
    if (normalized.startsWith('..')) return;

    const samples = result.fileSamples.get(normalized) ?? [];
    samples.push(n);
    result.fileSamples.set(normalized, samples);
  };

  const registerFileDurationsObject = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;

    for (const [file, value] of Object.entries(obj)) {
      addSample(file, value);
    }
  };

  const registerVitestResults = (entries) => {
    if (!Array.isArray(entries)) return;

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') continue;

      const duration = parsePositiveNumber(entry.duration)
        ?? (parsePositiveNumber(entry.endTime) && parsePositiveNumber(entry.startTime)
          ? Number(entry.endTime) - Number(entry.startTime)
          : undefined);

      addSample(entry.name, duration);
    }
  };

  for (const maybePath of inputPaths) {
    const absolutePath = toAbsolutePath(maybePath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    } catch {
      continue;
    }

    result.loadedPaths.push(normalizeRelativePath(absolutePath));

    if (!parsed || typeof parsed !== 'object') {
      continue;
    }

    registerFileDurationsObject(parsed.files);
    registerFileDurationsObject(parsed.fileDurations);
    registerVitestResults(parsed.testResults);
  }

  return result;
}

function createFileEstimator(timingInputs, durationBaseline, laneByFile) {
  const withForcedIsolateOverhead = (file, lane, estimateMs) => {
    const forcedIsolateFiles = lane ? laneConfig[lane]?.forceIsolateFiles ?? [] : [];
    return forcedIsolateFiles.includes(file)
      ? estimateMs + FORCED_ISOLATE_FILE_OVERHEAD_MS
      : estimateMs;
  };

  return (file) => {
    const lane = laneByFile.get(file);

    if (timingInputs.fileEstimates.has(file)) {
      return withForcedIsolateOverhead(file, lane, timingInputs.fileEstimates.get(file));
    }

    if (durationBaseline.fileEstimates.has(file)) {
      return withForcedIsolateOverhead(file, lane, durationBaseline.fileEstimates.get(file));
    }

    if (lane) {
      if (durationBaseline.laneAverages.has(lane)) {
        return withForcedIsolateOverhead(file, lane, durationBaseline.laneAverages.get(lane));
      }

      const laneKey = `${lane}/shared`;
      if (durationBaseline.laneEstimates.has(laneKey)) {
        return withForcedIsolateOverhead(file, lane, durationBaseline.laneEstimates.get(laneKey));
      }
    }

    return withForcedIsolateOverhead(file, lane, DEFAULT_FILE_ESTIMATE_MS);
  };
}

function computeBaselineAgeHours(generatedAt) {
  if (!generatedAt) {
    return null;
  }

  const timestamp = Date.parse(generatedAt);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return (Date.now() - timestamp) / (1000 * 60 * 60);
}

function resolveLptState(options, durationBaseline, timingInputs) {
  const baselineAgeHours = computeBaselineAgeHours(durationBaseline.generatedAt);
  const fileEstimateCount = new Set([
    ...durationBaseline.fileEstimates.keys(),
    ...timingInputs.fileEstimates.keys(),
  ]).size;
  const lptRequested = options.enableLpt;
  let lptEnabled = lptRequested;
  let lptDisabledReason = null;

  if (!lptRequested) {
    return {
      lptRequested: false,
      lptEnabled: false,
      lptDisabledReason: null,
      baselineAgeHours,
      fileEstimateCount,
    };
  }

  if (!durationBaseline.exists) {
    lptEnabled = false;
    lptDisabledReason = 'baseline_missing';
  } else if (fileEstimateCount < options.minFileEstimates) {
    lptEnabled = false;
    lptDisabledReason = 'insufficient_file_estimates';
  } else if (options.lptRequireFreshBaseline) {
    if (!durationBaseline.generatedAt) {
      lptEnabled = false;
      lptDisabledReason = 'baseline_generated_at_missing';
    } else if (baselineAgeHours === null) {
      lptEnabled = false;
      lptDisabledReason = 'baseline_generated_at_invalid';
    } else if (baselineAgeHours > options.baselineMaxAgeHours) {
      lptEnabled = false;
      lptDisabledReason = 'baseline_stale';
    }
  }

  return {
    lptRequested,
    lptEnabled,
    lptDisabledReason,
    baselineAgeHours,
    fileEstimateCount,
  };
}

function buildExecutionTasks(selectedLanes, laneBuckets, durationBaseline) {
  const tasks = [];
  const laneResults = new Map();
  let order = 0;

  for (const laneName of selectedLanes) {
    const laneFiles = laneBuckets[laneName];
    const segments = buildLaneSegments(laneName, laneFiles);

    laneResults.set(laneName, {
      laneName,
      files: laneFiles.length,
      exitCode: 0,
      durationMs: 0,
      segments: [],
    });

    let previousTaskId = null;

    for (const segment of segments) {
      const taskId = `${laneName}/${segment.segmentName}`;
      const estimatedMs = durationBaseline.laneEstimates.get(taskId)
        ?? durationBaseline.laneEstimates.get(`${laneName}/shared`)
        ?? durationBaseline.laneAverages.get(laneName)
        ?? 0;

      tasks.push({
        id: taskId,
        laneName,
        segmentName: segment.segmentName,
        segmentOrder: segment.segmentOrder,
        files: segment.files,
        forceIsolate: segment.forceIsolate,
        dependencyId: previousTaskId,
        order,
        estimatedMs,
        queuedAt: Date.now(),
      });
      previousTaskId = taskId;
      order += 1;
    }
  }

  return { tasks, laneResults };
}

function resolveMaxProcs(mode, option, laneCount) {
  if (laneCount <= 1) return 1;

  if (option !== 'auto') {
    return Math.max(1, Math.min(option, laneCount));
  }

  const base = mode === 'ci' ? 2 : 3;
  return Math.max(1, Math.min(base, laneCount));
}

function pickNextTask(readyTasks, enableLpt) {
  if (!enableLpt) {
    return readyTasks.sort((a, b) => a.order - b.order)[0];
  }

  return readyTasks
    .sort((a, b) => {
      if (b.estimatedMs !== a.estimatedMs) return b.estimatedMs - a.estimatedMs;
      return a.order - b.order;
    })[0];
}

function appendSegmentResult(laneResults, laneName, segmentResult) {
  const lane = laneResults.get(laneName);
  if (!lane) return;

  lane.segments.push(segmentResult);
  lane.durationMs += segmentResult.durationMs;
  if (segmentResult.exitCode !== 0) {
    lane.exitCode = 1;
  }
}

function markDependencyFailures(pendingTasks, completed, laneResults) {
  let changed = false;

  for (let i = pendingTasks.length - 1; i >= 0; i -= 1) {
    const task = pendingTasks[i];
    if (!task.dependencyId) continue;

    const dependency = completed.get(task.dependencyId);
    if (!dependency || dependency.exitCode === 0) {
      continue;
    }

    pendingTasks.splice(i, 1);
    const skipped = {
      segmentName: task.segmentName,
      files: task.files.length,
      exitCode: 1,
      durationMs: 0,
      queuedAt: task.queuedAt,
      startedAt: null,
      endedAt: null,
      spawnOverheadMs: 0,
      status: 'skipped_dependency_failure',
      segmentOrder: task.segmentOrder,
      vitestJsonReportPath: null,
    };

    completed.set(task.id, { exitCode: 1 });
    appendSegmentResult(laneResults, task.laneName, skipped);
    changed = true;
  }

  return changed;
}

async function runLaneTask(task, passthrough) {
  const taskLabel = `${task.laneName}/${task.segmentName}`;
  console.log(`[test:run] start ${taskLabel}: ${task.files.length} files`);

  const vitestJsonReportPath = buildVitestJsonReportPath(task.vitestJsonOutDir, task);
  if (vitestJsonReportPath) {
    fs.mkdirSync(path.dirname(vitestJsonReportPath), { recursive: true });
    if (fs.existsSync(vitestJsonReportPath)) {
      fs.unlinkSync(vitestJsonReportPath);
    }
  }

  const startedAt = Date.now();
  const args = buildVitestArgs(
    task.laneName,
    task.files,
    passthrough,
    task.forceIsolate,
    vitestJsonReportPath
  );
  const result = await spawnVitest(args);
  const endedAt = Date.now();

  const segmentResult = {
    segmentName: task.segmentName,
    files: task.files.length,
    exitCode: result.exitCode,
    durationMs: endedAt - startedAt,
    queuedAt: task.queuedAt,
    startedAt,
    endedAt,
    spawnOverheadMs: result.spawnOverheadMs,
    status: 'executed',
    segmentOrder: task.segmentOrder,
    vitestJsonReportPath: vitestJsonReportPath && result.exitCode === 0 && fs.existsSync(vitestJsonReportPath)
      ? toProjectPathOrAbsolute(vitestJsonReportPath)
      : null,
  };

  console.log(`[test:run] finish ${taskLabel}: exit=${segmentResult.exitCode} durationMs=${segmentResult.durationMs}`);
  return segmentResult;
}

async function runWithPool(taskQueue, laneResults, maxProcs, passthrough, enableLpt, vitestJsonOutDir, mode, shardLabel) {
  const pendingTasks = [...taskQueue];
  const completed = new Map();
  let active = 0;

  return new Promise((resolve) => {
    const schedule = () => {
      markDependencyFailures(pendingTasks, completed, laneResults);

      while (active < maxProcs) {
        const readyTasks = pendingTasks.filter((task) => {
          if (!task.dependencyId) return true;
          const dep = completed.get(task.dependencyId);
          return Boolean(dep && dep.exitCode === 0);
        });

        if (readyTasks.length === 0) {
          break;
        }

        const task = pickNextTask(readyTasks, enableLpt);
        const index = pendingTasks.findIndex((candidate) => candidate.id === task.id);
        if (index === -1) {
          continue;
        }

        pendingTasks.splice(index, 1);
        active += 1;

        runLaneTask({
          ...task,
          mode,
          shardLabel,
          vitestJsonOutDir,
        }, passthrough)
          .then((segmentResult) => {
            completed.set(task.id, { exitCode: segmentResult.exitCode });
            appendSegmentResult(laneResults, task.laneName, segmentResult);
          })
          .catch(() => {
            const failed = {
              segmentName: task.segmentName,
              files: task.files.length,
              exitCode: 1,
              durationMs: 0,
              queuedAt: task.queuedAt,
              startedAt: Date.now(),
              endedAt: Date.now(),
              spawnOverheadMs: 0,
              status: 'runner_error',
              segmentOrder: task.segmentOrder,
              vitestJsonReportPath: null,
            };
            completed.set(task.id, { exitCode: 1 });
            appendSegmentResult(laneResults, task.laneName, failed);
          })
          .finally(() => {
            active -= 1;
            if (pendingTasks.length === 0 && active === 0) {
              resolve();
            } else {
              schedule();
            }
          });
      }

      if (pendingTasks.length === 0 && active === 0) {
        resolve();
      }
    };

    schedule();
  });
}

function writeTiming(timingPath, payload) {
  if (!timingPath) return;
  const absolutePath = path.isAbsolute(timingPath)
    ? timingPath
    : path.join(projectRoot, timingPath);

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, JSON.stringify(payload, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const overrides = loadOverrides(options.overridesPath);
  const quarantine = loadQuarantine(options.quarantinePath);
  const durationBaseline = loadDurationBaseline(options.durationBaselinePath);
  const timingInputs = loadTimingInputs(options.timingInputPaths);

  const discoveredFiles = collectTestFiles(srcRoot);
  const laneByFile = classifyAllFiles(discoveredFiles, overrides);

  const { effectiveFiles, excludedFiles } = filterByQuarantine(
    discoveredFiles,
    quarantine.files,
    options.includeQuarantine
  );

  const estimateFile = createFileEstimator(timingInputs, durationBaseline, laneByFile);
  const lptState = resolveLptState(options, durationBaseline, timingInputs);
  const effectiveLanes = buildBuckets(effectiveFiles, laneByFile);
  const lanes = {};
  for (const laneName of ALL_LANES) {
    lanes[laneName] = applyShard(
      effectiveLanes[laneName],
      options.shard,
      options.strategy,
      estimateFile
    );
  }

  const shardFiles = ALL_LANES
    .flatMap((laneName) => lanes[laneName])
    .sort();
  const shardEstimatedWeightMs = shardFiles
    .reduce((sum, file) => sum + Math.max(1, Math.floor(estimateFile(file))), 0);
  validatePartition(shardFiles, lanes);

  console.log(`[test:run] discovered ${discoveredFiles.length} files`);
  console.log(`[test:run] effective files ${effectiveFiles.length} (quarantineExcluded=${excludedFiles.length})`);
  if (options.shard) {
    console.log(`[test:run] shard ${options.shard.value}: ${shardFiles.length} files strategy=${options.strategy}`);
  }

  for (const laneName of ALL_LANES) {
    console.log(`[test:run] lane ${laneName}: ${lanes[laneName].length}`);
  }

  const selectedLanes = options.selectedLanes;
  const { tasks, laneResults } = buildExecutionTasks(selectedLanes, lanes, durationBaseline);

  const activeLaneCount = selectedLanes
    .filter((laneName) => lanes[laneName] && lanes[laneName].length > 0)
    .length;
  const maxProcs = resolveMaxProcs(options.mode, options.maxProcsOption, activeLaneCount || 1);

  console.log(`[test:run] mode=${options.mode} maxProcs=${maxProcs} selectedLanes=${selectedLanes.join(',')}`);
  console.log(`[test:run] scheduler=${lptState.lptEnabled ? 'lpt' : 'fifo'} lptRequested=${lptState.lptRequested} lptDisabledReason=${lptState.lptDisabledReason ?? 'none'}`);
  console.log(`[test:run] durationBaseline=${durationBaseline.path} loaded=${durationBaseline.exists} baselineAgeHours=${lptState.baselineAgeHours === null ? 'unknown' : lptState.baselineAgeHours.toFixed(2)}`);
  console.log(`[test:run] fileEstimates baseline=${durationBaseline.fileEstimates.size} timingIn=${timingInputs.fileEstimates.size} effective=${lptState.fileEstimateCount}`);
  console.log(`[test:run] shardEstimatedWeightMs=${shardEstimatedWeightMs}`);
  console.log(`[test:run] timingIn loaded=${timingInputs.loadedPaths.length}/${options.timingInputPaths.length} includeQuarantine=${options.includeQuarantine}`);
  if (options.vitestJsonOutDir) {
    console.log(`[test:run] vitestJsonOutDir=${options.vitestJsonOutDir}`);
  }

  if (tasks.length === 0) {
    console.log('[test:run] no tasks to execute.');
  }

  const startedAt = Date.now();
  await runWithPool(
    tasks,
    laneResults,
    maxProcs,
    options.passthrough,
    lptState.lptEnabled,
    options.vitestJsonOutDir,
    options.mode,
    options.shard?.value ?? 'all'
  );
  const totalDurationMs = Date.now() - startedAt;

  const laneOutput = selectedLanes.map((laneName) => {
    const lane = laneResults.get(laneName) ?? {
      laneName,
      files: lanes[laneName].length,
      exitCode: 0,
      durationMs: 0,
      segments: [],
    };

    const segments = [...lane.segments]
      .sort((a, b) => a.segmentOrder - b.segmentOrder)
      .map(({ segmentOrder, ...segment }) => segment);

    return {
      laneName: lane.laneName,
      files: lane.files,
      exitCode: lane.exitCode,
      durationMs: lane.durationMs,
      segments,
    };
  });

  const generatedVitestReportPaths = laneOutput.flatMap((lane) =>
    lane.segments
      .map((segment) => segment.vitestJsonReportPath)
      .filter((reportPath) => typeof reportPath === 'string' && reportPath.length > 0)
  );
  const generatedVitestObservations = collectTimingObservations(generatedVitestReportPaths);
  const fileDurations = {};
  for (const [file, samples] of generatedVitestObservations.fileSamples.entries()) {
    const observedMean = mean(samples);
    if (!observedMean) continue;
    fileDurations[file] = Math.max(1, Math.round(observedMean));
  }

  writeTiming(options.timingOut, {
    mode: options.mode,
    shard: options.shard?.value ?? null,
    strategy: options.strategy,
    discoveredFiles: discoveredFiles.length,
    effectiveFiles: effectiveFiles.length,
    quarantineExcludedFiles: excludedFiles.length,
    shardFiles: shardFiles.length,
    shardEstimatedWeightMs,
    maxProcs,
    scheduler: lptState.lptEnabled ? 'lpt' : 'fifo',
    lptRequested: lptState.lptRequested,
    lptEnabled: lptState.lptEnabled,
    lptDisabledReason: lptState.lptDisabledReason,
    fileEstimateCount: lptState.fileEstimateCount,
    baselineAgeHours: lptState.baselineAgeHours === null
      ? null
      : Number(lptState.baselineAgeHours.toFixed(3)),
    includeQuarantine: options.includeQuarantine,
    vitestJsonOutDir: options.vitestJsonOutDir ?? null,
    quarantine: {
      path: options.quarantinePath,
      loaded: quarantine.exists,
      entries: quarantine.files.size,
    },
    durationBaseline: {
      path: options.durationBaselinePath,
      loaded: durationBaseline.exists,
      schemaVersion: durationBaseline.schemaVersion,
      generatedAt: durationBaseline.generatedAt,
      laneEntries: durationBaseline.laneEstimates.size,
      fileEntries: durationBaseline.fileEstimates.size,
    },
    timingInput: {
      requestedPaths: options.timingInputPaths,
      loadedPaths: timingInputs.loadedPaths,
      fileEntries: timingInputs.fileEstimates.size,
    },
    generatedVitestReports: {
      requestedPaths: generatedVitestReportPaths,
      loadedPaths: generatedVitestObservations.loadedPaths,
      fileEntries: generatedVitestObservations.fileSamples.size,
    },
    files: fileDurations,
    lanes: laneOutput,
    durationMs: totalDurationMs,
    createdAt: new Date().toISOString(),
  });

  if (laneOutput.some((result) => result.exitCode !== 0)) {
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[test:run] failed: ${message}`);
  process.exit(1);
});
