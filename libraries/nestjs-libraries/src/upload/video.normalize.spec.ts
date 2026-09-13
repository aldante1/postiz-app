import {
  normalizeFfmpegArgs,
  parseVideoProbe,
  videoComplianceIssues,
} from './video.normalize';

const incompatibleProbe = {
  streams: [
    {
      index: 0,
      codec_name: 'h264',
      profile: 'High 4:4:4 Predictive',
      codec_type: 'video',
      width: 2560,
      height: 820,
      pix_fmt: 'yuv444p',
      r_frame_rate: '30/1',
      avg_frame_rate: '30/1',
      duration: '12.000000',
    },
    {
      index: 1,
      codec_name: 'aac',
      codec_type: 'audio',
      sample_rate: '48000',
      channels: 2,
    },
  ],
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '12.000000',
  },
  fast_start: true,
};

const compatibleProbe = {
  streams: [
    {
      index: 0,
      codec_name: 'h264',
      profile: 'High',
      codec_type: 'video',
      width: 1920,
      height: 1080,
      pix_fmt: 'yuv420p',
      r_frame_rate: '30000/1001',
      avg_frame_rate: '30000/1001',
      duration: '12.012000',
    },
    {
      index: 1,
      codec_name: 'aac',
      codec_type: 'audio',
      sample_rate: '48000',
      channels: 2,
    },
  ],
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '12.012000',
  },
  fast_start: true,
};

describe('Postiz upload video compatibility', () => {
  it('reports the exact unsupported H.264 profile and pixel format', () => {
    const info = parseVideoProbe(incompatibleProbe);

    expect(info).not.toBeNull();
    expect(videoComplianceIssues(info!)).toEqual(
      expect.arrayContaining([
        'profile "High 4:4:4 Predictive" is not browser-decodable',
        'pix_fmt "yuv444p" must be yuv420p',
      ])
    );
  });

  it('accepts a browser-decodable High yuv420p video', () => {
    const info = parseVideoProbe(compatibleProbe);

    expect(info).not.toBeNull();
    expect(videoComplianceIssues(info!)).toEqual([]);
  });

  it('does not add audio encoding arguments when the input has no audio', () => {
    const info = parseVideoProbe({
      ...compatibleProbe,
      streams: [compatibleProbe.streams[0]],
    });

    expect(info).not.toBeNull();
    expect(
      normalizeFfmpegArgs('input.mp4', 'output.mp4', info!)
    ).toEqual([
      '-y',
      '-i',
      'input.mp4',
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v',
      'libx264',
      '-profile:v',
      'high',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '18',
      '-preset',
      'medium',
      '-movflags',
      '+faststart',
      'output.mp4',
    ]);
  });

  it('repairs an odd height with the canonical even-dimension scale filter', () => {
    const info = parseVideoProbe({
      ...compatibleProbe,
      streams: [{ ...compatibleProbe.streams[0], height: 821 }],
    });

    expect(info).not.toBeNull();
    expect(videoComplianceIssues(info!)).toContain('height 821 must be even');
    expect(normalizeFfmpegArgs('input.mp4', 'output.mp4', info!)).toEqual(
      expect.arrayContaining([
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      ])
    );
  });
});
