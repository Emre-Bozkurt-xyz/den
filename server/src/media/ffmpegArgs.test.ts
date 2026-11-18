/**
 * Pure tests for the ffmpeg argument builders (ffmpegArgs.ts). These pin the
 * privacy-carrying flags — a refactor that drops `-map_metadata -1` from any
 * stored-file command would silently start shipping iPhone GPS again.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  STRIP_METADATA,
  videoFallbackRemuxPlan,
  videoRemuxArgs,
  videoTranscodeArgs,
  voiceTranscodeArgs,
} from './ffmpegArgs.js';

/** The strip flags must appear as adjacent pairs, and before the output path
 *  (ffmpeg options apply to the NEXT file named on the command line). */
function assertStripsMetadata(args: string[], outPath: string): void {
  const outIdx = args.lastIndexOf(outPath);
  assert.equal(outIdx, args.length - 1, 'output path is the last argument');
  const mm = args.indexOf('-map_metadata');
  const mc = args.indexOf('-map_chapters');
  assert.ok(mm > args.indexOf('-i') && mm < outIdx, '-map_metadata is an output option');
  assert.equal(args[mm + 1], '-1');
  assert.ok(mc > args.indexOf('-i') && mc < outIdx, '-map_chapters is an output option');
  assert.equal(args[mc + 1], '-1');
}

describe('ffmpeg args strip container metadata', () => {
  test('STRIP_METADATA is exactly the two pairs', () => {
    assert.deepEqual([...STRIP_METADATA], ['-map_metadata', '-1', '-map_chapters', '-1']);
  });

  test('video remux', () => {
    const args = videoRemuxArgs('/t/in', '/t/out.mp4');
    assertStripsMetadata(args, '/t/out.mp4');
    assert.ok(args.includes('copy'));
  });

  test('video transcode, with and without audio', () => {
    const withAudio = videoTranscodeArgs('/t/in', '/t/out.mp4', true);
    assertStripsMetadata(withAudio, '/t/out.mp4');
    assert.ok(withAudio.includes('aac'));
    const silent = videoTranscodeArgs('/t/in', '/t/out.mp4', false);
    assertStripsMetadata(silent, '/t/out.mp4');
    assert.ok(silent.includes('-an'));
  });

  test('voice transcode', () => {
    assertStripsMetadata(voiceTranscodeArgs('/t/in', '/t/out.m4a'), '/t/out.m4a');
  });
});

describe('videoFallbackRemuxPlan', () => {
  test('mov/mp4 family remuxes to mp4 with metadata stripped', () => {
    const plan = videoFallbackRemuxPlan('/t/in', '/t', 'mov,mp4,m4a,3gp,3g2,mj2', 'h264');
    assert.ok(plan);
    assertStripsMetadata(plan.args, plan.outPath);
    assert.equal(plan.filename, 'video.mp4');
    assert.ok(!plan.args.includes('hvc1'));
  });

  test('HEVC gets the hvc1 tag Safari requires', () => {
    const plan = videoFallbackRemuxPlan('/t/in', '/t', 'mov,mp4,m4a,3gp,3g2,mj2', 'hevc');
    assert.ok(plan);
    const i = plan.args.indexOf('-tag:v');
    assert.equal(plan.args[i + 1], 'hvc1');
  });

  test('webm stays webm', () => {
    const plan = videoFallbackRemuxPlan('/t/in', '/t', 'matroska,webm', 'vp9');
    assert.ok(plan);
    assertStripsMetadata(plan.args, plan.outPath);
    assert.equal(plan.filename, 'video.webm');
  });

  test('unknown containers get no plan (caller keeps the raw original)', () => {
    assert.equal(videoFallbackRemuxPlan('/t/in', '/t', 'avi', 'mpeg4'), null);
    assert.equal(videoFallbackRemuxPlan('/t/in', '/t', null, null), null);
  });
});
