import { invoke } from '@tauri-apps/api/core'
import {
  CustomSource, EncodedPacketSink, EncodedVideoPacketSource, Input, MP4, QTFF, WEBM,
  Mp4OutputFormat, Output, StreamTarget, WebMOutputFormat,
} from 'mediabunny'

const block = 1024 * 1024
type VideoFile = { token: string; size: number }

function inputFor({ token, size }: VideoFile) {
  const part = async (start: number, end: number) => new Uint8Array(await invoke<ArrayBuffer>(
    'read_video_part', { token, offset: start, length: end - start },
  ))
  return new Input({
    formats: [MP4, WEBM, QTFF],
    source: new CustomSource({
      getSize: () => size,
      prefetchProfile: 'fileSystem',
      read(start, end) {
        if (end - start <= block) return part(start, end)
        let offset = start
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = Math.min(end, offset + block)
            controller.enqueue(await part(offset, next))
            offset = next
            if (offset === end) controller.close()
          },
        })
      },
    }),
  })
}

export async function countAudioTracks(id: string) {
  const opened = await invoke<VideoFile>('open_video_io', { jobId: id, writing: false })
  const input = inputFor(opened)
  try {
    return (await input.getAudioTracks()).length
  } finally {
    input.dispose()
    await invoke('close_video_io', { token: opened.token, format: null })
  }
}

export async function exportSilentVideo(id: string) {
  const opened = await invoke<VideoFile>('open_video_io', { jobId: id, writing: true })
  const input = inputFor(opened)
  let output: Output | undefined
  let closed = false
  try {
    const webm = (await input.getFormat()) === WEBM
    const format = webm ? new WebMOutputFormat() : new Mp4OutputFormat()
    const tracks = await input.getVideoTracks()
    if (!tracks.length) throw new Error('原文件中没有可导出的视频轨道。')
    const writable = new WritableStream({
      async write({ data, position }: { data: Uint8Array; position: number }) {
        for (let i = 0; i < data.byteLength; i += block) {
          await invoke('write_video_part', data.subarray(i, i + block), {
            headers: { 'x-video-session': opened.token, 'x-offset': String(position + i) },
          })
        }
      },
    })
    output = new Output({ format, target: new StreamTarget(writable, { chunked: true, chunkSize: block }) })
    const streams = []
    for (const track of tracks) {
      const codec = await track.getCodec()
      if (!codec || !format.getSupportedVideoCodecs().includes(codec)) {
        throw new Error('当前编码无法原样写入无音轨副本。')
      }
      const source = new EncodedVideoPacketSource(codec)
      output.addVideoTrack(source, { rotation: await track.getRotation() })
      streams.push({ track, source, config: await track.getDecoderConfig() })
    }
    await output.start()
    await Promise.all(streams.map(async ({ track, source, config }) => {
      let first = true
      for await (const packet of new EncodedPacketSink(track).packets()) {
        await source.add(packet, first && config ? { decoderConfig: config } : undefined)
        first = false
      }
      if (first) throw new Error('视频轨道中没有画面。')
      source.close()
    }))
    await output.finalize()
    closed = true
    return await invoke<string>('close_video_io', { token: opened.token, format: webm ? 'webm' : 'mp4' })
  } finally {
    if (output && (output.state === 'started' || output.state === 'pending')) await output.cancel().catch(() => {})
    input.dispose()
    if (!closed) await invoke('close_video_io', { token: opened.token, format: null })
  }
}

export async function measuredDuration(id: string) {
  const opened = await invoke<VideoFile>('open_video_io', {jobId:id,writing:false})
  const input=inputFor(opened)
  try { const seconds=await input.computeDuration(); if(!Number.isFinite(seconds)||seconds<=0) throw Error('无法读取视频实际时长。');return seconds }
  finally {input.dispose();await invoke('close_video_io',{token:opened.token,format:null})}
}
