'use strict';

const fc = require('fast-check');

// Mock AWS SDK clients (required by publisher module on import)
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({})),
  GetObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({})),
  GetSecretValueCommand: jest.fn(),
}));

const { _internals } = require('../../lambda/publisher/index');
const { generateJekyllPost, generateWebVTT, parseTranscriptSegments, formatTimestamp, escapeYaml } = _internals;

// --- Arbitraries ---

// Event title: printable non-empty string without control characters
const arbTitle = fc.string({ minLength: 1, maxLength: 100 })
  .filter((s) => s.trim().length > 0 && !/[\x00-\x1F\x7F]/.test(s));

// Event description: printable string
const arbDescription = fc.string({ minLength: 0, maxLength: 300 })
  .filter((s) => !/[\x00-\x1F\x7F]/.test(s));

// ISO date string
const arbDate = fc.integer({ min: 1600000000000, max: 1900000000000 })
  .map((ms) => new Date(ms).toISOString());

// Duration in seconds
const arbDuration = fc.integer({ min: 0, max: 36000 });

// HLS URL
const arbHlsUrl = fc.string({ minLength: 5, maxLength: 30 })
  .filter((s) => /^[a-zA-Z0-9_-]+$/.test(s))
  .map((s) => `https://cdn.example.com/recordings/${s}/media/master.m3u8`);

// Caption path
const arbCaptionPath = fc.string({ minLength: 3, maxLength: 20 })
  .filter((s) => /^[a-zA-Z0-9_-]+$/.test(s))
  .map((s) => `/assets/captions/${s}.vtt`);

// Metadata object for generateJekyllPost
const arbMetadata = fc.record({
  title: arbTitle,
  description: arbDescription,
  scheduledStart: arbDate,
  duration: arbDuration,
});

// WebVTT timestamp components
const arbHours = fc.integer({ min: 0, max: 23 });
const arbMinutes = fc.integer({ min: 0, max: 59 });
const arbSeconds = fc.integer({ min: 0, max: 59 });
const arbMillis = fc.integer({ min: 0, max: 999 });

// Generate a formatted timestamp string HH:MM:SS.mmm
const arbTimestampStr = fc.tuple(arbHours, arbMinutes, arbSeconds, arbMillis)
  .map(([h, m, s, ms]) =>
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
  );

// Convert timestamp string to total seconds for ordering
function timestampToSeconds(ts) {
  const [hms, msStr] = ts.split('.');
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s + Number(msStr) / 1000;
}

// Generate a transcript segment with start < end
const arbSegment = fc.tuple(arbHours, arbMinutes, arbSeconds, arbMillis, fc.integer({ min: 1, max: 30 }))
  .chain(([h, m, s, ms, durationSec]) => {
    const startTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    const endTotalMs = (h * 3600 + m * 60 + s) * 1000 + ms + durationSec * 1000;
    const endH = Math.floor(endTotalMs / 3600000);
    const endM = Math.floor((endTotalMs % 3600000) / 60000);
    const endS = Math.floor((endTotalMs % 60000) / 1000);
    const endMs = endTotalMs % 1000;
    const endTime = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:${String(endS).padStart(2, '0')}.${String(endMs).padStart(3, '0')}`;

    return fc.string({ minLength: 1, maxLength: 100 })
      .filter((s) => s.trim().length > 0 && !/[\x00-\x1F\x7F]/.test(s) && !s.includes('-->') && !s.includes('|'))
      .map((text) => ({
        startTime,
        endTime,
        text: text.trim(),
      }));
  });

// Array of transcript segments (ordered by start time)
const arbSegments = fc.array(arbSegment, { minLength: 1, maxLength: 20 })
  .map((segments) => {
    // Sort segments by start time to ensure chronological order
    return segments.sort((a, b) => timestampToSeconds(a.startTime) - timestampToSeconds(b.startTime));
  });

// --- Property Tests ---

describe('Publication Property Tests', () => {
  /**
   * Property 20: Playback Page Contains Required Content
   * **Validates: Requirements 21.2, 22.3**
   *
   * For any recording with metadata (title, description, date, HLS URL),
   * the generated playback page should contain the HLS URL, event title,
   * and caption track reference.
   */
  describe('Property 20: Playback Page Contains Required Content', () => {
    it('generated Jekyll post contains HLS URL, event title, and caption track reference', () => {
      fc.assert(
        fc.property(
          arbMetadata,
          arbHlsUrl,
          arbCaptionPath,
          (metadata, hlsUrl, captionPath) => {
            const result = generateJekyllPost(metadata, hlsUrl, captionPath);

            // Must contain the HLS URL
            expect(result).toContain(hlsUrl);

            // Must contain the event title
            expect(result).toContain(metadata.title);

            // Must contain the caption track reference
            expect(result).toContain(captionPath);

            // Must contain YAML front matter delimiters
            expect(result).toMatch(/^---\n/);
            expect(result).toContain('\n---\n');

            // Front matter must include hls_url field
            expect(result).toContain(`hls_url: "${hlsUrl}"`);

            // Front matter must include caption_url field
            expect(result).toContain(`caption_url: "${captionPath}"`);

            // Must contain a <track> element referencing captions
            expect(result).toContain(`<track kind="captions" src="${captionPath}"`);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('generated Jekyll post contains event date in front matter', () => {
      fc.assert(
        fc.property(
          arbMetadata,
          arbHlsUrl,
          arbCaptionPath,
          (metadata, hlsUrl, captionPath) => {
            const result = generateJekyllPost(metadata, hlsUrl, captionPath);

            // Front matter must include the date
            expect(result).toContain(`date: ${metadata.scheduledStart}`);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('generated Jekyll post contains video element with HLS.js setup', () => {
      fc.assert(
        fc.property(
          arbMetadata,
          arbHlsUrl,
          arbCaptionPath,
          (metadata, hlsUrl, captionPath) => {
            const result = generateJekyllPost(metadata, hlsUrl, captionPath);

            // Must contain a video element
            expect(result).toContain('<video');

            // Must reference HLS.js library
            expect(result).toContain('hls.js');

            // Must use the HLS URL in the script
            expect(result).toContain(`var videoSrc = '${hlsUrl}'`);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 21: WebVTT Generation from Transcription Segments
   * **Validates: Requirements 22.1**
   *
   * For any sequence of transcript segments with start/end times and text,
   * the generated WebVTT file should be valid (starts with WEBVTT header,
   * contains all segments in order, uses correct timestamp format).
   */
  describe('Property 21: WebVTT Generation from Transcription Segments', () => {
    it('generated WebVTT starts with WEBVTT header', () => {
      fc.assert(
        fc.property(
          arbSegments,
          (segments) => {
            const result = generateWebVTT(segments);

            // Must start with WEBVTT header
            expect(result).toMatch(/^WEBVTT\n/);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('generated WebVTT contains all segments in order', () => {
      fc.assert(
        fc.property(
          arbSegments,
          (segments) => {
            const result = generateWebVTT(segments);

            // Each segment text must appear in the output
            for (const seg of segments) {
              expect(result).toContain(seg.text);
            }

            // Segments must appear in order (each segment's text position should be after the previous)
            let lastIndex = 0;
            for (const seg of segments) {
              const index = result.indexOf(seg.text, lastIndex);
              expect(index).toBeGreaterThanOrEqual(lastIndex);
              lastIndex = index + seg.text.length;
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('generated WebVTT uses correct timestamp format (HH:MM:SS.mmm --> HH:MM:SS.mmm)', () => {
      fc.assert(
        fc.property(
          arbSegments,
          (segments) => {
            const result = generateWebVTT(segments);
            const lines = result.split('\n');

            // Find all timestamp lines (lines containing -->)
            const timestampLines = lines.filter((line) => line.includes('-->'));

            // Should have exactly as many timestamp lines as segments
            expect(timestampLines.length).toBe(segments.length);

            // Each timestamp line must match the WebVTT timestamp format
            const timestampPattern = /^\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}$/;
            for (const tsLine of timestampLines) {
              expect(tsLine).toMatch(timestampPattern);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('generated WebVTT contains numbered cue identifiers', () => {
      fc.assert(
        fc.property(
          arbSegments,
          (segments) => {
            const result = generateWebVTT(segments);
            const lines = result.split('\n');

            // After the WEBVTT header and blank line, cues should be numbered sequentially
            for (let i = 0; i < segments.length; i++) {
              expect(lines).toContain(String(i + 1));
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('formatTimestamp produces valid HH:MM:SS.mmm format', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 86400 }),
          (totalSeconds) => {
            const result = formatTimestamp(totalSeconds);

            // Must match HH:MM:SS.mmm format
            expect(result).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);

            // Parse back and verify components are valid
            const [hms, msStr] = result.split('.');
            const [h, m, s] = hms.split(':').map(Number);
            const ms = Number(msStr);

            expect(h).toBeGreaterThanOrEqual(0);
            expect(m).toBeGreaterThanOrEqual(0);
            expect(m).toBeLessThan(60);
            expect(s).toBeGreaterThanOrEqual(0);
            expect(s).toBeLessThan(60);
            expect(ms).toBeGreaterThanOrEqual(0);
            expect(ms).toBeLessThan(1000);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('parseTranscriptSegments correctly parses formatted transcript lines', () => {
      fc.assert(
        fc.property(
          arbSegments,
          (segments) => {
            // Build transcript text in the expected format
            const transcriptText = segments
              .map((seg) => `${seg.startTime} --> ${seg.endTime} | ${seg.text}`)
              .join('\n');

            const parsed = parseTranscriptSegments(transcriptText);

            // Should produce the same number of segments
            expect(parsed.length).toBe(segments.length);

            // Each parsed segment should match the original
            for (let i = 0; i < segments.length; i++) {
              expect(parsed[i].startTime).toBe(segments[i].startTime);
              expect(parsed[i].endTime).toBe(segments[i].endTime);
              expect(parsed[i].text).toBe(segments[i].text);
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
