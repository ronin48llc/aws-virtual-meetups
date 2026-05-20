'use strict';

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const s3Client = new S3Client({});
const secretsClient = new SecretsManagerClient({});
const lambdaClient = new LambdaClient({});
const EMAIL_LAMBDA_ARN = process.env.EMAIL_LAMBDA_ARN;

/**
 * Publisher Lambda handler
 * Triggered by EventBridge on S3 recording completion.
 * Reads recording metadata from S3, generates a Jekyll markdown post and WebVTT caption file,
 * then commits them to a GitHub repository via the GitHub REST API.
 */
exports.handler = async (event) => {
  console.log('Publisher Lambda invoked:', JSON.stringify(event));

  try {
    const s3Detail = extractS3Details(event);
    if (!s3Detail) {
      console.log('Event does not contain valid S3 object details, skipping.');
      return { statusCode: 200, body: 'Skipped: no valid S3 details' };
    }

    const { bucket, key } = s3Detail;
    const eventId = extractEventId(key);
    if (!eventId) {
      console.log('Could not extract eventId from key:', key);
      return { statusCode: 200, body: 'Skipped: could not determine eventId' };
    }

    // Read metadata.json from S3
    const metadataKey = `recordings/${eventId}/metadata.json`;
    const metadata = await readJsonFromS3(bucket, metadataKey);

    // Read transcript segments from S3 (captions.vtt source or transcript.txt)
    const transcriptKey = `recordings/${eventId}/transcript.txt`;
    const transcriptText = await readTextFromS3(bucket, transcriptKey);

    // Generate WebVTT caption file from transcript segments
    const segments = parseTranscriptSegments(transcriptText);
    const webvttContent = generateWebVTT(segments);

    // Generate Jekyll markdown post
    const cloudfrontDomain = process.env.CLOUDFRONT_DOMAIN || '';
    const hlsUrl = `https://${cloudfrontDomain}/recordings/${eventId}/media/master.m3u8`;
    const captionPath = `/assets/captions/${eventId}.vtt`;
    const markdownContent = generateJekyllPost(metadata, hlsUrl, captionPath);

    // Get GitHub token from Secrets Manager
    const githubToken = await getGitHubToken();

    // Commit files to GitHub
    const githubOwner = process.env.GITHUB_OWNER;
    const githubRepo = process.env.GITHUB_REPO;

    await commitFilesToGitHub({
      token: githubToken,
      owner: githubOwner,
      repo: githubRepo,
      files: [
        {
          path: `_posts/${formatDateForFilename(metadata.scheduledStart || metadata.date)}-${eventId}.md`,
          content: markdownContent,
        },
        {
          path: `assets/captions/${eventId}.vtt`,
          content: webvttContent,
        },
        {
          path: `assets/transcripts/${eventId}.txt`,
          content: transcriptText,
        },
      ],
      message: `Add recording for event: ${metadata.title || eventId}`,
    });

    console.log(`Successfully published recording for event ${eventId}`);

    // Async invoke email Lambda for recap notification (fire-and-forget)
    await invokeEmailLambda({
      type: 'recap',
      eventId,
      playbackUrl: hlsUrl,
      duration: metadata.duration || 0,
    });

    return { statusCode: 200, body: JSON.stringify({ message: 'Published successfully', eventId }) };
  } catch (error) {
    console.error('Publisher Lambda error:', error);
    throw error;
  }
};

/**
 * Extract S3 bucket and key from EventBridge event
 */
function extractS3Details(event) {
  // EventBridge S3 event format
  if (event.detail && event.detail.bucket && event.detail.object) {
    return {
      bucket: event.detail.bucket.name,
      key: event.detail.object.key,
    };
  }
  // Alternative: detail may contain requestParameters
  if (event.detail && event.detail.requestParameters) {
    return {
      bucket: event.detail.requestParameters.bucketName,
      key: event.detail.requestParameters.key,
    };
  }
  return null;
}

/**
 * Extract eventId from S3 key (recordings/{eventId}/...)
 */
function extractEventId(key) {
  const match = key.match(/^recordings\/([^/]+)\//);
  return match ? match[1] : null;
}

/**
 * Read and parse JSON from S3
 */
async function readJsonFromS3(bucket, key) {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await s3Client.send(command);
  const body = await response.Body.transformToString();
  return JSON.parse(body);
}

/**
 * Read text content from S3
 */
async function readTextFromS3(bucket, key) {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await s3Client.send(command);
  return response.Body.transformToString();
}

/**
 * Parse transcript text into segments.
 * Expected format: each line is "startTime --> endTime | text"
 * e.g. "00:00:01.000 --> 00:00:04.500 | Welcome to the meetup"
 * If the format doesn't match, treat each line as a segment with auto-generated timestamps.
 */
function parseTranscriptSegments(text) {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const lines = text.trim().split('\n').filter(line => line.trim().length > 0);
  const segments = [];

  for (const line of lines) {
    const pipeMatch = line.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})\s*\|\s*(.+)$/);
    if (pipeMatch) {
      segments.push({
        startTime: pipeMatch[1],
        endTime: pipeMatch[2],
        text: pipeMatch[3].trim(),
      });
    } else {
      // Fallback: auto-generate timestamps (5 seconds per segment)
      const index = segments.length;
      const startSeconds = index * 5;
      const endSeconds = startSeconds + 5;
      segments.push({
        startTime: formatTimestamp(startSeconds),
        endTime: formatTimestamp(endSeconds),
        text: line.trim(),
      });
    }
  }

  return segments;
}

/**
 * Format seconds into WebVTT timestamp (HH:MM:SS.mmm)
 */
function formatTimestamp(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const millis = Math.round((totalSeconds % 1) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/**
 * Generate a valid WebVTT file from transcript segments
 */
function generateWebVTT(segments) {
  let vtt = 'WEBVTT\n\n';

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    vtt += `${i + 1}\n`;
    vtt += `${seg.startTime} --> ${seg.endTime}\n`;
    vtt += `${seg.text}\n\n`;
  }

  return vtt;
}

/**
 * Generate a Jekyll markdown post with front matter
 */
function generateJekyllPost(metadata, hlsUrl, captionPath) {
  const title = metadata.title || 'Untitled Event';
  const description = metadata.description || '';
  const date = metadata.scheduledStart || metadata.date || new Date().toISOString();
  const duration = metadata.duration || 0;

  const frontMatter = [
    '---',
    `title: "${escapeYaml(title)}"`,
    `date: ${date}`,
    `description: "${escapeYaml(description)}"`,
    `hls_url: "${hlsUrl}"`,
    `caption_url: "${captionPath}"`,
    `duration: ${duration}`,
    'layout: recording',
    '---',
  ].join('\n');

  // Issue #87: escape user-supplied title/description before interpolating
  // into the markdown body. Markdown allows raw HTML, and Jekyll renders it.
  // Without escaping, an organizer can inject persistent <script> into the
  // public GitHub Pages recording site.
  const safeTitle = escapeMarkdownHtml(title);
  const safeDescription = escapeMarkdownHtml(description);

  const body = [
    '',
    `# ${safeTitle}`,
    '',
    safeDescription,
    '',
    '## Watch Recording',
    '',
    `<video id="recording-player" controls></video>`,
    '',
    '<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>',
    '<script>',
    `  var video = document.getElementById('recording-player');`,
    `  var videoSrc = '${hlsUrl}';`,
    '  if (Hls.isSupported()) {',
    '    var hls = new Hls();',
    '    hls.loadSource(videoSrc);',
    '    hls.attachMedia(video);',
    '  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {',
    '    video.src = videoSrc;',
    '  }',
    '</script>',
    '',
    `<track kind="captions" src="${captionPath}" srclang="en" label="English" default>`,
    '',
  ].join('\n');

  return frontMatter + body;
}

/**
 * Escape HTML special characters for safe inclusion in markdown bodies that
 * may be rendered by Jekyll (which permits raw HTML). See issue #87.
 */
function escapeMarkdownHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape special characters for YAML strings
 */
function escapeYaml(str) {
  return str.replace(/"/g, '\\"').replace(/\n/g, ' ');
}

/**
 * Format a date string for Jekyll filename (YYYY-MM-DD)
 */
function formatDateForFilename(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) {
      return new Date().toISOString().split('T')[0];
    }
    return d.toISOString().split('T')[0];
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

/**
 * Get GitHub token from Secrets Manager
 */
async function getGitHubToken() {
  const secretArn = process.env.GITHUB_TOKEN_SECRET_ARN;
  if (!secretArn) {
    throw new Error('GITHUB_TOKEN_SECRET_ARN environment variable is not set');
  }

  const command = new GetSecretValueCommand({ SecretId: secretArn });
  const response = await secretsClient.send(command);
  return response.SecretString;
}

/**
 * Commit multiple files to a GitHub repository using the GitHub REST API.
 * Uses the Git Data API (trees and commits) to commit multiple files atomically.
 */
async function commitFilesToGitHub({ token, owner, repo, files, message }) {
  const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // 1. Get the reference for the default branch (main)
  const refResponse = await fetch(`${baseUrl}/git/ref/heads/main`, { headers });
  if (!refResponse.ok) {
    throw new Error(`Failed to get ref: ${refResponse.status} ${await refResponse.text()}`);
  }
  const refData = await refResponse.json();
  const latestCommitSha = refData.object.sha;

  // 2. Get the tree of the latest commit
  const commitResponse = await fetch(`${baseUrl}/git/commits/${latestCommitSha}`, { headers });
  if (!commitResponse.ok) {
    throw new Error(`Failed to get commit: ${commitResponse.status} ${await commitResponse.text()}`);
  }
  const commitData = await commitResponse.json();
  const baseTreeSha = commitData.tree.sha;

  // 3. Create blobs for each file
  const treeItems = [];
  for (const file of files) {
    const blobResponse = await fetch(`${baseUrl}/git/blobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        content: Buffer.from(file.content).toString('base64'),
        encoding: 'base64',
      }),
    });
    if (!blobResponse.ok) {
      throw new Error(`Failed to create blob for ${file.path}: ${blobResponse.status} ${await blobResponse.text()}`);
    }
    const blobData = await blobResponse.json();
    treeItems.push({
      path: file.path,
      mode: '100644',
      type: 'blob',
      sha: blobData.sha,
    });
  }

  // 4. Create a new tree
  const treeResponse = await fetch(`${baseUrl}/git/trees`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: treeItems,
    }),
  });
  if (!treeResponse.ok) {
    throw new Error(`Failed to create tree: ${treeResponse.status} ${await treeResponse.text()}`);
  }
  const treeData = await treeResponse.json();

  // 5. Create a new commit
  const newCommitResponse = await fetch(`${baseUrl}/git/commits`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      message,
      tree: treeData.sha,
      parents: [latestCommitSha],
    }),
  });
  if (!newCommitResponse.ok) {
    throw new Error(`Failed to create commit: ${newCommitResponse.status} ${await newCommitResponse.text()}`);
  }
  const newCommitData = await newCommitResponse.json();

  // 6. Update the reference to point to the new commit
  const updateRefResponse = await fetch(`${baseUrl}/git/refs/heads/main`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      sha: newCommitData.sha,
    }),
  });
  if (!updateRefResponse.ok) {
    throw new Error(`Failed to update ref: ${updateRefResponse.status} ${await updateRefResponse.text()}`);
  }

  return newCommitData;
}

/**
 * Asynchronously invoke the Email Lambda (fire-and-forget).
 * @param {Object} payload - The email invocation payload.
 */
async function invokeEmailLambda(payload) {
  if (!EMAIL_LAMBDA_ARN) {
    return;
  }
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: EMAIL_LAMBDA_ARN,
      InvocationType: 'Event',
      Payload: JSON.stringify(payload),
    }));
  } catch (err) {
    console.error('Failed to invoke email Lambda:', {
      error: err.message,
      type: payload.type,
      eventId: payload.eventId,
    });
  }
}

// Export internals for testing
exports._internals = {
  extractS3Details,
  extractEventId,
  parseTranscriptSegments,
  formatTimestamp,
  generateWebVTT,
  generateJekyllPost,
  escapeYaml,
  escapeMarkdownHtml,
  formatDateForFilename,
  commitFilesToGitHub,
  readJsonFromS3,
  readTextFromS3,
  getGitHubToken,
  invokeEmailLambda,
};
