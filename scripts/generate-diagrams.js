'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DESIGN_DOC_PATH = path.resolve(__dirname, '../.kiro/specs/virtual-meetup-platform/design.md');
const OUTPUT_DIR = path.resolve(__dirname, '../docs/diagrams');

/**
 * Extracts Mermaid code blocks from a markdown file.
 * Returns an array of { name, code } objects.
 */
function extractMermaidBlocks(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const blocks = [];
  const regex = /```mermaid\s*\n([\s\S]*?)```/g;
  let match;
  let index = 0;

  while ((match = regex.exec(content)) !== null) {
    index++;
    // Try to find a heading before this block for naming
    const beforeBlock = content.substring(0, match.index);
    const headingMatch = beforeBlock.match(/#+\s+(.+)\s*$/m);
    const name = headingMatch
      ? headingMatch[1].replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()
      : `diagram-${index}`;

    blocks.push({ name, code: match[1].trim() });
  }

  return blocks;
}

/**
 * Renders Mermaid blocks to PNG and SVG using mmdc (mermaid-cli).
 */
function renderDiagrams(blocks, outputDir) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const results = [];

  for (const block of blocks) {
    const inputFile = path.join(outputDir, `${block.name}.mmd`);
    const pngFile = path.join(outputDir, `${block.name}.png`);
    const base = path.resolve(outputDir);
    const target = path.resolve(outputDir, `${block.name}.svg`);
    const relative = path.relative(base, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Invalid file path');
    }
    const svgFile = target;

    // Write Mermaid source
    fs.writeFileSync(inputFile, block.code);

    try {
      // Render PNG
      execSync(`npx mmdc -i "${inputFile}" -o "${pngFile}" -b transparent`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      console.log(`  ✓ ${block.name}.png`);
    } catch (err) {
      console.error(`  ✗ ${block.name}.png - ${err.message}`);
    }

    try {
      // Render SVG
      execSync(`npx mmdc -i "${inputFile}" -o "${svgFile}" -b transparent`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      console.log(`  ✓ ${block.name}.svg`);
    } catch (err) {
      console.error(`  ✗ ${block.name}.svg - ${err.message}`);
    }

    // Clean up .mmd source file
    try {
      fs.unlinkSync(inputFile);
    } catch (err) {
      // ignore
    }

    results.push({ name: block.name, png: pngFile, svg: svgFile });
  }

  return results;
}

function main() {
  console.log('=== Mermaid Diagram Generator ===\n');

  // Check if design doc exists
  if (!fs.existsSync(DESIGN_DOC_PATH)) {
    console.error(`Design document not found: ${DESIGN_DOC_PATH}`);
    process.exit(1);
  }

  console.log(`Reading: ${DESIGN_DOC_PATH}`);
  const blocks = extractMermaidBlocks(DESIGN_DOC_PATH);

  if (blocks.length === 0) {
    console.log('No Mermaid blocks found in design document.');
    process.exit(0);
  }

  console.log(`Found ${blocks.length} Mermaid diagram(s)\n`);
  console.log(`Output directory: ${OUTPUT_DIR}\n`);

  const results = renderDiagrams(blocks, OUTPUT_DIR);

  console.log(`\nDone. Generated ${results.length} diagram(s) in ${OUTPUT_DIR}`);
}

if (require.main === module) {
  main();
}

module.exports = { extractMermaidBlocks, renderDiagrams };
