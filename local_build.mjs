#!/usr/bin/env zx

import { $, echo, fs, chalk, spinner } from 'zx';

// Disable verbose mode for cleaner output
$.verbose = false;
process.env.FORCE_COLOR = '1';

// --- Configuration ---
const config = {
	appVersion: process.env.APP_VERSION_TAG || '1.97.0',
	nodeVersion: process.env.NODE_VERSION_ARG || '20',
	n8nReleaseType: process.env.N8N_RELEASE_TYPE_ARG || 'stable',
	launcherVersion: process.env.LAUNCHER_VERSION_ARG || '1.1.2',
	dockerfilePath: './docker/images/n8n/Dockerfile',
	imageBaseName: process.env.IMAGE_BASE_NAME || 'n8n-local',
	imageTag: process.env.IMAGE_TAG || 'dev',
	buildContext: '.',
	compiledAppDir: './compiled_app_output',
};

const actualNodeVersionUsed = process.env.NODE_VERSION_ARG || '22';
config.nodeVersion = actualNodeVersionUsed;

config.fullImageName = `${config.imageBaseName}:${config.imageTag}`;

// --- Platform Detection ---
const localArch = (await $`uname -m`).stdout.trim();
const isArm = localArch === 'arm64' || localArch === 'aarch64';
const defaultPlatform = isArm ? 'linux/arm64' : 'linux/amd64';
const targetPlatform = process.env.OVERRIDE_TARGET_PLATFORM || defaultPlatform;
const builderPlatform = process.env.OVERRIDE_BUILDER_PLATFORM || defaultPlatform;

// --- Helper Functions ---
const timers = new Map();

function startTimer(name) {
	timers.set(name, Date.now());
}

function getElapsedTime(name) {
	const start = timers.get(name);
	if (!start) return 0;
	return Math.floor((Date.now() - start) / 1000);
}

function formatDuration(seconds) {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;

	if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
	if (minutes > 0) return `${minutes}m ${secs}s`;
	return `${secs}s`;
}

function printHeader(title) {
	echo('');
	echo(chalk.blue.bold(`===== ${title} =====`));
}

function printDivider() {
	echo(chalk.gray('-----------------------------------------------'));
}

function parseSizeToBytes(sizeString) {
	const match = sizeString.match(/^([\d.]+)\s*(GB|MB|M|KB|K|B)$/i);
	if (!match) {
		echo(chalk.yellow(`WARN: Could not parse size string '${sizeString}'. Returning 0 bytes.`));
		return 0;
	}

	let value = parseFloat(match[1]);
	const unit = match[2].toUpperCase();

	switch (unit) {
		case 'GB':
			return value * 1024 * 1024 * 1024;
		case 'MB':
		case 'M':
			return value * 1024 * 1024; // Handle both MB and M
		case 'KB':
		case 'K':
			return value * 1024; // Handle both KB and K
		case 'B':
			return value;
		default:
			return 0; // Should not happen with the regex
	}
}

// --- Main Build Process ---
printHeader('Local n8n Build & Dockerize');
echo(`INFO: Dockerfile: ${config.dockerfilePath}`);
echo(`INFO: Output Image: ${config.fullImageName}`);
echo(`INFO: Artifacts Dir: ${config.compiledAppDir}`);
printDivider();

// Check required tools
const requiredTools = ['pnpm', 'jq', 'node', 'docker'];
for (const tool of requiredTools) {
	try {
		await $`command -v ${tool}`;
	} catch {
		echo(chalk.red(`Error: ${tool} could not be found. Please install it.`));
		process.exit(1);
	}
}

startTimer('total_build');

// 0. Clean Previous Build Output
echo(chalk.yellow(`INFO: Cleaning previous output directory: ${config.compiledAppDir}...`));
await fs.remove(config.compiledAppDir);
printDivider();

// 1. Local Application Pre-build
echo(chalk.yellow('INFO: Starting local application pre-build...'));
startTimer('package_build');

await spinner(chalk.cyan('Running pnpm install and build...'), async () => {
	await $`pnpm install --frozen-lockfile`;
	await $`pnpm build`;
});

const packageBuildTime = getElapsedTime('package_build');
echo(chalk.green(`✅ Package build completed in ${formatDuration(packageBuildTime)}`));
printDivider();

// 2. Prepare for deployment - clean package.json files
echo(chalk.yellow('INFO: Performing pre-deploy cleanup on package.json files...'));

// Find and backup package.json files
const packageJsonFiles = await $`find . -name "package.json" \
  -not -path "./node_modules/*" \
  -not -path "*/node_modules/*" \
  -not -path "./${config.compiledAppDir}/*" \
  -type f`.lines();

// Backup all package.json files
for (const file of packageJsonFiles) {
	if (file) await fs.copy(file, `${file}.bak`);
}

// Define backend patches to keep during deployment
const PATCHES_TO_KEEP = ['pdfjs-dist', 'pkce-challenge', 'bull'];

// Perform selective patch cleanup
echo(chalk.yellow('INFO: Performing selective patch cleanup...'));

const packageJsonPath = './package.json';

if (await fs.pathExists(packageJsonPath)) {
	try {
		// 1. Read the package.json file
		const packageJsonContent = await fs.readFile(packageJsonPath, 'utf8');
		let packageJson = JSON.parse(packageJsonContent);

		// 2. Modify the patchedDependencies directly in JavaScript
		if (packageJson.pnpm && packageJson.pnpm.patchedDependencies) {
			const filteredPatches = {};
			for (const [key, value] of Object.entries(packageJson.pnpm.patchedDependencies)) {
				// Check if the key (patch name) starts with any of the allowed patches
				const shouldKeep = PATCHES_TO_KEEP.some((patchPrefix) => key.startsWith(patchPrefix));
				if (shouldKeep) {
					filteredPatches[key] = value;
				}
			}
			packageJson.pnpm.patchedDependencies = filteredPatches;
		}

		// 3. Write the modified package.json back
		await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf8');

		echo(chalk.green('✅ Kept backend patches: ' + PATCHES_TO_KEEP.join(', ')));
		echo(chalk.gray('   Removed FE/dev patches: element-plus, vue-tsc, @types/*, eslint-plugin'));
	} catch (error) {
		echo(chalk.red(`ERROR: Failed to cleanup patches in package.json: ${error.message}`));
		process.exit(1); // Exit with an error code
	}
}

// Run FE trim script
await $`node .github/scripts/trim-fe-packageJson.js`;

echo(chalk.yellow(`INFO: Creating pruned production deployment in '${config.compiledAppDir}'...`));
startTimer('package_deploy');

await fs.ensureDir(config.compiledAppDir);

await $`NODE_ENV=production DOCKER_BUILD=true pnpm --filter=n8n --prod --legacy deploy ${config.compiledAppDir}`;

const packageDeployTime = getElapsedTime('package_deploy');

// Restore package.json files
for (const file of packageJsonFiles) {
	if (file && (await fs.pathExists(`${file}.bak`))) {
		await fs.move(`${file}.bak`, file, { overwrite: true });
	}
}

const compiledAppOutputSize = (await $`du -sh ${config.compiledAppDir} | cut -f1`).stdout.trim();
echo(chalk.green(`✅ Package deployment completed in ${formatDuration(packageDeployTime)}`));
echo(`INFO: Size of ${config.compiledAppDir}: ${compiledAppOutputSize}`);
printDivider();

// 4. Build Docker Image
echo(chalk.yellow(`INFO: Building Docker image: ${config.fullImageName}...`));
startTimer('docker_build');

let builtImageId;

try {
	const buildOutput = await $`DOCKER_BUILDKIT=1 docker build \
    --build-arg NODE_VERSION=${config.nodeVersion} \
    --build-arg N8N_VERSION=${config.appVersion} \
    --build-arg N8N_RELEASE_TYPE=${config.n8nReleaseType} \
    --build-arg LAUNCHER_VERSION=${config.launcherVersion} \
    --build-arg TARGETPLATFORM=${targetPlatform} \
    --build-arg BUILDER_PLATFORM_ARG=${builderPlatform} \
    -t ${config.fullImageName} \
    -f ${config.dockerfilePath} \
    ${config.buildContext} \
    --iidfile /tmp/n8n_image_id.txt`;

	echo(buildOutput.stdout); // Print all build output

	if (await fs.pathExists('/tmp/n8n_image_id.txt')) {
		builtImageId = (await fs.readFile('/tmp/n8n_image_id.txt', 'utf8')).trim();
		echo(chalk.blue(`INFO: Built image ID: ${builtImageId}`));
	} else {
		echo(chalk.red('ERROR: Could not get built image ID from --iidfile.'));
		// Fallback: try to find the image by tag and creation time (less reliable with buildx)
		builtImageId = (
			await $`docker images --filter "reference=${config.fullImageName}" --format "{{.ID}} {{.CreatedAt}}" | sort -r -k2 | head -n1 | cut -d' ' -f1`
		).stdout.trim();
		if (!builtImageId) {
			echo(
				chalk.red(
					'ERROR: Could not find built image ID using tag fallback. Script might be unstable.',
				),
			);
		}
	}
} catch (error) {
	echo(chalk.red(`ERROR: Docker build failed: ${error.stderr || error.message}`));
	process.exit(1);
} finally {
	await fs.remove('/tmp/n8n_image_id.txt').catch(() => {});
}

const dockerBuildTime = getElapsedTime('docker_build');
echo(chalk.green(`✅ Docker build completed in ${formatDuration(dockerBuildTime)}`));

// --- Get Docker Inspect Size for Final Image (Virtual Size) ---
let virtualSizeMB = 'N/A';
let virtualSizeBytes = 0; // Raw bytes for calculation
if (builtImageId) {
	try {
		virtualSizeBytes = parseInt(
			(await $`docker image inspect ${builtImageId} --format='{{.Size}}'`).stdout.trim(),
		);
		virtualSizeMB = (virtualSizeBytes / (1024 * 1024)).toFixed(2);
		echo(chalk.blue(`INFO: Docker Inspect Virtual Size for final image: ${virtualSizeMB} MB`));
	} catch (error) {
		echo(
			chalk.red(
				`ERROR: Could not get Virtual Size for final image ID ${builtImageId}: ${error.message}`,
			),
		);
	}
} else {
	echo(chalk.yellow('WARN: No image ID, cannot get Docker Inspect Virtual Size.'));
}

// --- Estimated Total Image Size ---
let estimatedTotalImageSizeMB = 'N/A';
const compiledAppOutputBytes = parseSizeToBytes(compiledAppOutputSize);
const bufferBytes = 300 * 1024 * 1024; // 300MB in bytes

// Calculate: app output size + virtual size + 300MB (other layer estimates)
if (compiledAppOutputBytes > 0 || virtualSizeBytes > 0) {
	estimatedTotalImageSizeMB = (
		(compiledAppOutputBytes + virtualSizeBytes + bufferBytes) /
		(1024 * 1024)
	).toFixed(2);
	echo(
		chalk.blue(
			`INFO: Estimated Total Image Size (App + Virtual + 300MB Buffer): ${estimatedTotalImageSizeMB} MB`,
		),
	);
} else {
	echo(
		chalk.yellow(
			'WARN: Could not calculate Estimated Total Image Size (missing compiled app size or virtual size).',
		),
	);
}

printDivider();

// Calculate total time
const totalBuildTime = getElapsedTime('total_build');

// --- Final Output ---
echo('');
echo(chalk.green.bold('================ BUILD SUMMARY ================'));
echo(
	chalk.green(
		`✅ Docker Image Built: ${config.fullImageName} (ID: ${builtImageId ? builtImageId.substring(0, 12) : 'N/A'})`,
	),
);
echo('');
echo(chalk.blue('📏 Image Sizes:'));
echo(`   Compiled App Output Size:       ${compiledAppOutputSize}`);
echo(chalk.gray(`     (Size of 'compiled_app_output' directory before Docker COPY.)`));
if (virtualSizeMB !== 'N/A') {
	echo(`   Docker Inspect Virtual Size:    ${virtualSizeMB} MB`);
	echo(
		chalk.gray(
			`     (Size reported by 'docker images SIZE' for the final image. May not match Docker Desktop's aggregated view.)`,
		),
	);
}
if (estimatedTotalImageSizeMB !== 'N/A') {
	echo(
		chalk.bold.green(
			`   Estimated Total Image Size:     ${estimatedTotalImageSizeMB} MB (${(parseFloat(estimatedTotalImageSizeMB) / 1024).toFixed(2)} GB)`,
		),
	);
	echo(
		chalk.gray(
			`     (Calculated as Compiled App Output Size + Docker Inspect Virtual Size + ~300MB for other layers/overhead.)`,
		),
	);
} else {
	echo(
		chalk.yellow(
			`   Could not estimate total image size (missing compiled app size or virtual size).`,
		),
	);
}
echo('');
echo(chalk.blue('⏱️  Build Times:'));
echo(`   Package Build:  ${formatDuration(packageBuildTime)}`);
echo(`   Package Deploy: ${formatDuration(packageDeployTime)}`);
echo(`   Docker Build:   ${formatDuration(dockerBuildTime)}`);
echo(chalk.gray('   -----------------------------'));
echo(chalk.bold(`   Total Time:     ${formatDuration(totalBuildTime)}`));
echo(chalk.green.bold('=============================================='));
