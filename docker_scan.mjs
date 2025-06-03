#!/usr/bin/env zx

import { $, echo, fs, chalk, spinner } from 'zx';

// Enable colors
process.env.FORCE_COLOR = '1';
$.verbose = false;

// --- Configuration ---
const buildMetadataFile = '.build_metadata.json';
const imageBaseName = process.env.IMAGE_BASE_NAME || 'n8n-local';
const imageTag = process.env.IMAGE_TAG || 'dev';
const defaultImageName = `${imageBaseName}:${imageTag}`;

echo(chalk.blue.bold('===== Docker Image Vulnerability Scan ====='));

// Check for required tools
const requiredTools = ['trivy', 'jq'];
for (const tool of requiredTools) {
	try {
		await $`command -v ${tool}`;
	} catch {
		echo(chalk.red(`Error: ${tool} could not be found. Please install it.`));
		process.exit(1);
	}
}

// Initialize variables
let fullImageName = defaultImageName;
let buildTimestamp = null;
let compressedSize = null;
let uncompressedSize = null;

// Check if build metadata exists
if (await fs.pathExists(buildMetadataFile)) {
	echo(chalk.green('INFO: Found build metadata file'));
	const metadata = await fs.readJson(buildMetadataFile);
	fullImageName = metadata.image_name;
	buildTimestamp = metadata.build_timestamp;
	compressedSize = metadata.compressed_size_mb;
	uncompressedSize = metadata.uncompressed_size_mb;
	echo(`INFO: Scanning image built at: ${buildTimestamp}`);
} else {
	echo(chalk.yellow('WARN: No build metadata file found. Using default image name.'));

	// Check if image exists
	try {
		await $`docker image inspect ${fullImageName}`;
	} catch {
		echo(chalk.red(`ERROR: Docker image ${fullImageName} not found!`));
		echo('Please run ./build.mjs first or specify a different image.');
		process.exit(1);
	}

	// Get sizes manually
	try {
		const imageSizeBytes = parseInt(
			(await $`docker image inspect ${fullImageName} --format='{{.Size}}'`).stdout.trim(),
		);
		compressedSize = (imageSizeBytes / (1024 * 1024)).toFixed(2);

		// Try to get uncompressed size
		const uncompressedBytes = parseInt(
			(await $`docker save ${fullImageName} | wc -c`).stdout.trim(),
		);
		uncompressedSize = (uncompressedBytes / (1024 * 1024)).toFixed(2);
	} catch {
		echo(chalk.yellow('WARN: Could not calculate image sizes'));
	}
}

// Allow override via environment variable
fullImageName = process.env.SCAN_IMAGE_NAME || fullImageName;

echo(`INFO: Image to scan: ${fullImageName}`);
echo(chalk.gray('-----------------------------------------------'));

// Generate report filenames
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
const safeImageName = fullImageName.replace(/[^a-zA-Z0-9-]/g, '_');
const trivyReportFile = `trivy_report_${safeImageName}_${timestamp}.txt`;
const trivyJsonFile = `trivy_report_${safeImageName}_${timestamp}.json`;
const summaryFile = `scan_summary_${safeImageName}_${timestamp}.txt`;

// Run Trivy Scan
echo(chalk.yellow('INFO: Scanning image with Trivy...'));
const scanSpinner = spinner(chalk.cyan('Running vulnerability scan...')).start();

let scanSuccess = true;
let vulnCounts = {};
let totalVulns = 0;
let uniqueCves = 0;

try {
	// Generate text report
	await $`trivy image --scanners vuln --quiet ${fullImageName} > ${trivyReportFile}`;

	// Generate JSON report for analysis
	await $`trivy image --scanners vuln --format json --quiet ${fullImageName} > ${trivyJsonFile}`;

	scanSpinner.succeed(chalk.green('Vulnerability scan completed'));
} catch (error) {
	scanSpinner.warn(chalk.yellow('Scan completed with warnings'));
	scanSuccess = false;
}

// Parse vulnerability counts from JSON
if (await fs.pathExists(trivyJsonFile)) {
	try {
		const jsonData = await fs.readJson(trivyJsonFile);
		const severityMap = {};
		const cveSet = new Set();

		if (jsonData.Results) {
			for (const result of jsonData.Results) {
				if (result.Vulnerabilities) {
					for (const vuln of result.Vulnerabilities) {
						severityMap[vuln.Severity] = (severityMap[vuln.Severity] || 0) + 1;
						totalVulns++;
						cveSet.add(vuln.VulnerabilityID);
					}
				}
			}
		}

		vulnCounts = severityMap;
		uniqueCves = cveSet.size;
	} catch (error) {
		echo(chalk.yellow('WARN: Could not parse JSON report'));
	}
}

echo('INFO: Scan complete.');
echo(chalk.gray('-----------------------------------------------'));

// Generate summary report
const summaryContent = `Docker Image Security Scan Summary
==================================
Date: ${new Date().toString()}
Image: ${fullImageName}

Image Information:
------------------
Compressed Size:   ${compressedSize || 'N/A'} MB
Uncompressed Size: ${uncompressedSize || 'N/A'} MB

Vulnerability Summary:
----------------------
Total Vulnerabilities: ${totalVulns}
Unique CVEs: ${uniqueCves}

Breakdown by Severity:
${
	Object.entries(vulnCounts).length > 0
		? Object.entries(vulnCounts)
				.sort(([a], [b]) => {
					const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
					return order.indexOf(a) - order.indexOf(b);
				})
				.map(([severity, count]) => `${severity}: ${count}`)
				.join('\n')
		: 'No vulnerabilities found'
}

Report Files:
-------------
Text Report: ${trivyReportFile}
JSON Report: ${trivyJsonFile}
This Summary: ${summaryFile}
`;

await fs.writeFile(summaryFile, summaryContent);

// --- Final Output ---
echo('');
echo(chalk.green.bold('================ SCAN SUMMARY ================'));
echo(`🔍 Scanned Image: ${chalk.bold(fullImageName)}`);
echo('');

if (compressedSize && uncompressedSize) {
	echo(chalk.blue('📏 Image Sizes:'));
	echo(`   Compressed:   ${compressedSize} MB`);
	echo(`   Uncompressed: ${uncompressedSize} MB`);
	echo('');
}

echo(chalk.blue('🛡️  Vulnerability Summary:'));
if (totalVulns === 0) {
	echo(chalk.green('   ✨ No vulnerabilities found!'));
} else {
	echo(chalk.yellow(`   Total: ${totalVulns} vulnerabilities (${uniqueCves} unique CVEs)`));

	// Show severity breakdown with colors
	const severityColors = {
		CRITICAL: chalk.red,
		HIGH: chalk.redBright,
		MEDIUM: chalk.yellow,
		LOW: chalk.blue,
		UNKNOWN: chalk.gray,
	};

	for (const [severity, count] of Object.entries(vulnCounts)) {
		const colorFn = severityColors[severity] || chalk.white;
		echo(`   ${colorFn(`${severity}: ${count}`)}`);
	}
}

echo('');
echo(chalk.blue('📄 Reports Generated:'));
echo(`   Text Report:  ${trivyReportFile}`);
echo(`   JSON Report:  ${trivyJsonFile}`);
echo(`   Summary:      ${summaryFile}`);
echo('');
echo(chalk.blue('💡 Tips:'));
echo('   - Review the text report for human-readable details');
echo('   - Use the JSON report for automated processing');
echo('   - Check CRITICAL and HIGH severity vulnerabilities first');
echo(chalk.green.bold('=============================================='));

// Show top 5 critical/high vulnerabilities if any exist
if (totalVulns > 0 && (await fs.pathExists(trivyJsonFile))) {
	try {
		const jsonData = await fs.readJson(trivyJsonFile);
		const criticalHighVulns = [];

		if (jsonData.Results) {
			for (const result of jsonData.Results) {
				if (result.Vulnerabilities) {
					for (const vuln of result.Vulnerabilities) {
						if (vuln.Severity === 'CRITICAL' || vuln.Severity === 'HIGH') {
							criticalHighVulns.push({
								severity: vuln.Severity,
								id: vuln.VulnerabilityID,
								title: vuln.Title || 'No title',
								pkgName: vuln.PkgName,
							});
						}
					}
				}
			}
		}

		if (criticalHighVulns.length > 0) {
			echo('');
			echo(chalk.red.bold('🚨 Top Critical/High Vulnerabilities:'));
			criticalHighVulns.slice(0, 5).forEach((vuln) => {
				const severityColor = vuln.severity === 'CRITICAL' ? chalk.red : chalk.redBright;
				echo(`   ${severityColor(vuln.severity)}: ${vuln.id} - ${vuln.title}`);
				if (vuln.pkgName) echo(chalk.gray(`      Package: ${vuln.pkgName}`));
			});

			if (criticalHighVulns.length > 5) {
				echo(chalk.gray(`   ... and ${criticalHighVulns.length - 5} more`));
			}
			echo('');
			echo(`Run ${chalk.cyan(`cat ${trivyReportFile}`)} to see the full report.`);
		}
	} catch (error) {
		// Silently fail if we can't parse the top vulnerabilities
	}
}
