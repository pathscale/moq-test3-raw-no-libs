import { Component, createSignal } from "solid-js";
import { Client } from "./moq/transport/client";
import type { Connection } from "./moq/transport/connection";
import type { SubscribeSend } from "./moq/transport/subscriber";
import { Broadcast } from "./moq/contribute/broadcast";
import * as Catalog from "./moq/media/catalog";
import * as MP4 from "./moq/media/mp4";
import { SubgroupReader } from "./moq/transport/subgroup";

type Result = {
  attempt: number;
  success: boolean;
  latency?: number;
  error?: string;
};

export const TestCall3: Component = () => {
  const [relayUrl, setRelayUrl] = createSignal(
    localStorage.getItem("moq-relay-url") || "http://localhost:4443"
  );
  const [attempts, setAttempts] = createSignal(20);

  const [logs, setLogs] = createSignal<string[]>([]);
  const [running, setRunning] = createSignal(false);
  const [sleepMs, setSleepMs] = createSignal(300);
  const [connectionResults, setConnectionResults] = createSignal<Result[]>([]);
  const [publishResults, setPublishResults] = createSignal<Result[]>([]);
  const [publishing, setPublishing] = createSignal(false);
  const [subscribeResults, setSubscribeResults] = createSignal<Result[]>([]);
  const [relayPath, setRelayPath] = createSignal("user1");
  const [schemeTesting, setSchemeTesting] = createSignal(false);
  const [subscribing, setSubscribing] = createSignal(false);

  let publishBroadcast: Broadcast | null = null;
  let publishConnection: Connection | null = null;
  let subConnection: Connection | null = null;
  let canvasEl: HTMLCanvasElement | undefined;
  let canvasCtx: CanvasRenderingContext2D | null = null;
  let videoDecoder: VideoDecoder | null = null;
  let activeSubscriptions: SubscribeSend[] = [];
  let subscribeAbort: AbortController | null = null;

  const log = (msg: string) => {
    console.log(msg);
    setLogs((prev) => [...prev, msg]);
  };

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  // Race a promise against the abort signal so subscribe loops can exit promptly
  const raceAbort = <T,>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> => {
    if (signal.aborted) return Promise.resolve(undefined);
    return Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        signal.addEventListener("abort", () => resolve(undefined), { once: true });
      }),
    ]);
  };

  const relayTarget = () => {
    const base = relayUrl().endsWith("/") ? relayUrl() : `${relayUrl()}/`;
    return `${base}${relayPath()}`;
  };

  // Create a MOQT Client from a relay URL.
  // Handles localhost http->https conversion and cert fingerprint URL derivation.
  const createMoqClient = (url: string): Client => {
    const parsed = new URL(url);
    let wtUrl = url;
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      wtUrl = url.replace(/^http:\/\//, "https://");
    }
    // Only fetch fingerprint for localhost (self-signed certs)
    const fingerprint = (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
      ? `http://${parsed.host}/certificate.sha256`
      : undefined;
    return new Client({ url: wtUrl, fingerprint });
  };

  const schemeTestUrls = () => {
    const parsed = new URL(relayUrl());
    const host = parsed.host;

    return [`moq://${host}`, `moqt://${host}`, `https://${host}`];
  };

  const formatSchemeError = (error: unknown) => {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
      };
    }

    return {
      name: typeof error,
      message: String(error),
    };
  };

  const runSchemeExperiment = async () => {
    if (typeof WebTransport === "undefined") {
      log(
        "[SCHEME_TEST] status=SKIP reason=WebTransport unsupported in this browser"
      );
      return;
    }

    let urls: string[];
    try {
      urls = schemeTestUrls();
    } catch (error) {
      const details = formatSchemeError(error);
      log(
        `[SCHEME_TEST] status=SKIP reason=invalid relay URL error_name=${details.name} error_message=${details.message}`
      );
      return;
    }

    setSchemeTesting(true);
    log("[SCHEME_TEST] starting alternative scheme probe");

    try {
      for (const url of urls) {
        let transport: WebTransport;

        try {
          transport = new WebTransport(url);
        } catch (error) {
          const details = formatSchemeError(error);
          log(
            `[SCHEME_TEST] scheme=${url} status=FAIL stage=constructor error_name=${details.name} error_message=${details.message}`
          );
          continue;
        }

        try {
          await transport.ready;
          log(`[SCHEME_TEST] scheme=${url} status=OK stage=ready`);
        } catch (error) {
          const details = formatSchemeError(error);
          log(
            `[SCHEME_TEST] scheme=${url} status=FAIL stage=ready error_name=${details.name} error_message=${details.message}`
          );
        } finally {
          transport.close();
        }
      }
    } finally {
      log("[SCHEME_TEST] complete");
      setSchemeTesting(false);
    }
  };

  const runSingleTest = async (attempt: number): Promise<Result> => {
    const start = performance.now();
    log(`Attempt #${attempt} — starting MOQT session`);

    let connectPromise: Promise<Connection> | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      if (typeof WebTransport === "undefined") {
        throw new Error("WebTransport unsupported");
      }

      const client = createMoqClient(relayUrl());
      connectPromise = client.connect();

      const conn = await Promise.race([
        connectPromise,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("MOQT CONNECT TIMEOUT")), 10000);
        }),
      ]);

      clearTimeout(timeoutId);

      const latency = performance.now() - start;

      log(`Attempt #${attempt} — MOQT SESSION OK (${Math.round(latency)} ms)`);

      conn.close();

      return {
        attempt,
        success: true,
        latency,
      };
    } catch (err: any) {
      if (timeoutId) clearTimeout(timeoutId);
      // Clean up dangling connection if timeout won the race
      if (connectPromise) {
        connectPromise.then((c) => c.close()).catch(() => {});
      }

      log(`Attempt #${attempt} — FAIL: ${err?.message || err}`);

      return {
        attempt,
        success: false,
        error: err?.message || String(err),
      };
    }
  };

  const startPublishTest = async () => {
    const start = performance.now();
    try {
      if (typeof WebTransport === "undefined") {
        throw new Error("WebTransport unsupported");
      }

      log("Requesting camera/mic...");

      const media = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: 1280, height: 720, frameRate: 30 },
      });

      log("Connecting to relay via MOQT Client...");

      const client = createMoqClient(relayTarget());
      const connection = await client.connect();
      publishConnection = connection;

      const connectLatency = performance.now() - start;
      log(`MOQT publish connection ready (${Math.round(connectLatency)} ms)`);

      const namespace = [relayPath()];

      // Derive encoder configs from actual media track settings
      const videoTrack = media.getVideoTracks()[0];
      const audioTrack = media.getAudioTracks()[0];
      const videoSettings = videoTrack?.getSettings();
      const audioSettings = audioTrack?.getSettings();

      const videoWidth = videoSettings?.width ?? 1280;
      const videoHeight = videoSettings?.height ?? 720;
      const videoFrameRate = videoSettings?.frameRate ?? 30;

      // Resolve actual audio sample rate — getSettings() may omit it on some browsers
      let audioSampleRate = audioSettings?.sampleRate;
      if (!audioSampleRate && audioTrack) {
        const ctx = new AudioContext();
        audioSampleRate = ctx.sampleRate;
        await ctx.close();
      }
      const audioChannels = audioSettings?.channelCount ?? 1;

      if (audioTrack) {
        log(`Audio track: ${audioSampleRate}Hz, ${audioChannels}ch`);
      }

      const broadcast = new Broadcast({
        connection,
        namespace,
        media,
        video: videoTrack ? {
          codec: "avc1.42001f", // Baseline profile, level 3.1 (supports up to 1280x720)
          width: videoWidth,
          height: videoHeight,
          bitrate: 1_500_000,
          framerate: videoFrameRate,
        } : undefined,
        audio: audioTrack ? {
          codec: "opus",
          sampleRate: audioSampleRate ?? 48000,
          numberOfChannels: audioChannels,
          bitrate: 128_000,
        } : undefined,
      });
      publishBroadcast = broadcast;

      setPublishing(true);

      const latency = performance.now() - start;
      log("Publishing started (WebCodecs + MOQT)");
      setPublishResults((prev) => [
        ...prev,
        {
          attempt: prev.length + 1,
          success: true,
          latency,
        },
      ]);

      // Monitor for connection/broadcast close in background
      broadcast.closed().then((err) => {
        log(`Broadcast closed: ${err.message}`);
        setPublishing(false);
      });
    } catch (err: any) {
      setPublishResults((prev) => [
        ...prev,
        {
          attempt: prev.length + 1,
          success: false,
          error: err?.message || String(err),
        },
      ]);
      log(`Publish error: ${err?.message || err}`);
    }
  };

  const stopPublishTest = async () => {
    try {
      publishBroadcast?.close();
      publishBroadcast = null;
      if (publishConnection) {
        publishConnection.close();
        publishConnection = null;
      }
      setPublishing(false);
      log("Publishing stopped");
    } catch (err) {
      log("Stop publish error");
    }
  };

  const startSubscribeTest = async () => {
    const start = performance.now();

    try {
      if (typeof WebTransport === "undefined") {
        throw new Error("WebTransport unsupported");
      }

      if (!canvasEl) {
        log("Canvas element not ready");
        return;
      }
      canvasCtx = canvasEl.getContext("2d");
      if (!canvasCtx) {
        log("Failed to get canvas 2d context");
        return;
      }

      subscribeAbort = new AbortController();

      log("Connecting for subscribe via MOQT Client...");
      const client = createMoqClient(relayTarget());
      const connection = await client.connect();
      subConnection = connection;

      const connectLatency = performance.now() - start;
      log(`MOQT subscribe session established (${Math.round(connectLatency)} ms)`);

      // Fetch catalog to discover tracks (retry because publisher may still be registering)
      log("Fetching catalog...");
      const namespace = [relayPath()];
      let catalog: Catalog.Root | undefined;
      for (let retry = 0; retry < 5; retry++) {
        try {
          catalog = await Catalog.fetch(connection, namespace);
          break;
        } catch (e) {
          if (retry === 4) throw e;
          log(`Catalog not available yet, retrying in 1s... (${retry + 1}/5)`);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      if (!catalog) throw new Error("Failed to fetch catalog");
      log(`Catalog: ${catalog.tracks.length} tracks found`);
      for (const track of catalog.tracks) {
        const kind = Catalog.isVideoTrack(track) ? "video" : Catalog.isAudioTrack(track) ? "audio" : "data";
        log(`  Track: ${track.name} (${kind}), codec=${track.selectionParams?.codec ?? "?"}`);
      }

      setSubscribing(true);

      // Set up VideoDecoder for rendering to canvas
      videoDecoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
          if (!canvasEl || !canvasCtx) {
            frame.close();
            return;
          }
          canvasEl.width = frame.displayWidth;
          canvasEl.height = frame.displayHeight;
          canvasCtx.drawImage(frame, 0, 0, frame.displayWidth, frame.displayHeight);
          frame.close();
        },
        error: (err) => {
          log(`VideoDecoder error: ${err.message}`);
        },
      });

      // Store init data keyed by init track name
      const inits = new Map<string, Uint8Array>();

      // Subscribe to init tracks first
      const initTrackNames = new Set<string>();
      for (const track of catalog.tracks) {
        if (track.initTrack && (Catalog.isVideoTrack(track) || Catalog.isAudioTrack(track))) {
          initTrackNames.add(track.initTrack);
        }
      }

      for (const initName of initTrackNames) {
        log(`Subscribing to init track: ${initName}`);
        const sub = await connection.subscribe(namespace, initName);
        const segment = await sub.data();
        if (!segment) throw new Error(`No init data for ${initName}`);
        const chunk = await segment.read();
        if (!chunk || !(chunk.object_payload instanceof Uint8Array)) {
          throw new Error(`Invalid init data for ${initName}`);
        }
        inits.set(initName, chunk.object_payload);
        await sub.close();
        log(`Init track ${initName}: ${chunk.object_payload.byteLength} bytes`);
      }

      // Subscribe to video track
      const videoTrack = catalog.tracks.find(Catalog.isVideoTrack);
      if (videoTrack && videoTrack.namespace && videoTrack.initTrack) {
        log(`Subscribing to video track: ${videoTrack.name}`);
        const sub = await connection.subscribe(videoTrack.namespace, videoTrack.name);
        activeSubscriptions.push(sub);

        const initData = inits.get(videoTrack.initTrack);
        if (!initData) throw new Error(`Missing init data for video track`);
        const parser = new MP4.Parser(initData);

        let decoderConfigured = false;
        let waitingForKeyframe = true;

        // Process video segments in background
        const abortSignal = subscribeAbort.signal;
        (async () => {
          try {
            for (;;) {
              if (abortSignal.aborted) break;
              const segment = await raceAbort(sub.data(), abortSignal);
              if (!segment) break;

              if (!(segment instanceof SubgroupReader)) {
                log(`Unexpected segment type for video`);
                continue;
              }

              log(`Video segment group=${segment.header.group_id}`);

              // Wrap inner loop so RESET_STREAM on one segment doesn't kill the whole video loop
              try {
                for (;;) {
                  if (abortSignal.aborted) break;
                  const obj = await raceAbort(segment.read(), abortSignal);
                  if (!obj) break;
                  if (!(obj.object_payload instanceof Uint8Array)) continue;

                  const frames = parser.decode(obj.object_payload);
                  for (const frame of frames) {
                    if (!videoDecoder || videoDecoder.state === "closed") break;

                    // Configure decoder on first video frame
                    if (!decoderConfigured && MP4.isVideoTrack(frame.track)) {
                      const desc = frame.sample.description;
                      const box = desc.avcC ?? desc.hvcC ?? desc.vpcC ?? desc.av1C;
                      if (box) {
                        const buffer = new MP4.Stream(undefined, 0, MP4.Stream.BIG_ENDIAN);
                        box.write(buffer);
                        const description = new Uint8Array(buffer.buffer, 8);

                        videoDecoder.configure({
                          codec: frame.track.codec,
                          codedHeight: frame.track.video.height,
                          codedWidth: frame.track.video.width,
                          description,
                        });
                        decoderConfigured = true;
                        waitingForKeyframe = true;
                        log(`VideoDecoder configured: ${frame.track.codec} ${frame.track.video.width}x${frame.track.video.height}`);
                      }
                    }

                    if (decoderConfigured && videoDecoder.state === "configured") {
                      if (waitingForKeyframe && !frame.sample.is_sync) continue;
                      if (frame.sample.is_sync) waitingForKeyframe = false;

                      const chunk = new EncodedVideoChunk({
                        type: frame.sample.is_sync ? "key" : "delta",
                        data: frame.sample.data,
                        timestamp: frame.sample.dts,
                      });
                      try {
                        videoDecoder.decode(chunk);
                      } catch (e: any) {
                        log(`Decode error: ${e?.message}`);
                      }
                    }
                  }
                }
              } catch (segErr: any) {
                // RESET_STREAM / stream errors are normal QUIC congestion control — skip to next segment
                console.warn(`Video segment group=${segment.header.group_id} error:`, segErr?.message);
              }
            }
          } catch (err: any) {
            if (!subscribeAbort?.signal.aborted) {
              log(`Video subscribe loop error: ${err?.message || err}`);
            }
          }
        })();
      } else {
        log("No video track found in catalog");
      }

      // Subscribe to audio track (decode but don't play for now)
      const audioTrack = catalog.tracks.find(Catalog.isAudioTrack);
      if (audioTrack && audioTrack.namespace && audioTrack.initTrack) {
        log(`Subscribing to audio track: ${audioTrack.name}`);
        const sub = await connection.subscribe(audioTrack.namespace, audioTrack.name);
        activeSubscriptions.push(sub);

        const initData = inits.get(audioTrack.initTrack);
        if (!initData) throw new Error(`Missing init data for audio track`);
        const audioParser = new MP4.Parser(initData);

        // Set up AudioContext and AudioDecoder
        const audioCtx = new AudioContext({ latencyHint: "interactive" });
        const audioDecoder = new AudioDecoder({
          output: (audioData: AudioData) => {
            // Play audio via AudioContext
            const numberOfFrames = audioData.numberOfFrames;
            const sampleRate = audioData.sampleRate;
            const channels = audioData.numberOfChannels;
            const buffer = audioCtx.createBuffer(channels, numberOfFrames, sampleRate);
            for (let ch = 0; ch < channels; ch++) {
              const dest = buffer.getChannelData(ch);
              audioData.copyTo(dest, { planeIndex: ch, format: "f32-planar" });
            }
            audioData.close();
            const source = audioCtx.createBufferSource();
            source.buffer = buffer;
            source.connect(audioCtx.destination);
            source.start();
          },
          error: (err) => {
            log(`AudioDecoder error: ${err.message}`);
          },
        });

        let audioDecoderConfigured = false;

        // Process audio segments in background
        const audioAbortSignal = subscribeAbort.signal;
        (async () => {
          try {
            for (;;) {
              if (audioAbortSignal.aborted) break;
              const segment = await raceAbort(sub.data(), audioAbortSignal);
              if (!segment) break;

              if (!(segment instanceof SubgroupReader)) continue;

              try {
                for (;;) {
                  if (audioAbortSignal.aborted) break;
                  const obj = await raceAbort(segment.read(), audioAbortSignal);
                  if (!obj) break;
                  if (!(obj.object_payload instanceof Uint8Array)) continue;

                  const frames = audioParser.decode(obj.object_payload);
                  for (const frame of frames) {
                    if (audioDecoder.state === "closed") break;

                    if (!audioDecoderConfigured && MP4.isAudioTrack(frame.track)) {
                      audioDecoder.configure({
                        codec: frame.track.codec,
                        sampleRate: frame.track.audio.sample_rate,
                        numberOfChannels: frame.track.audio.channel_count,
                      });
                      audioDecoderConfigured = true;
                      log(`AudioDecoder configured: ${frame.track.codec}`);
                    }

                    if (audioDecoderConfigured && audioDecoder.state === "configured") {
                      const chunk = new EncodedAudioChunk({
                        type: frame.sample.is_sync ? "key" : "delta",
                        timestamp: frame.sample.dts,
                        duration: frame.sample.duration,
                        data: frame.sample.data,
                      });
                      try {
                        audioDecoder.decode(chunk);
                      } catch (e: any) {
                        log(`Audio decode error: ${e?.message}`);
                      }
                    }
                  }
                }
              } catch (segErr: any) {
                console.warn(`Audio segment error:`, segErr?.message);
              }
            }
          } catch (err: any) {
            if (!subscribeAbort?.signal.aborted) {
              log(`Audio subscribe loop error: ${err?.message || err}`);
            }
          } finally {
            audioDecoder.close();
            await audioCtx.close();
          }
        })();
      } else {
        log("No audio track found in catalog");
      }

      const latency = performance.now() - start;
      setSubscribeResults((prev) => [
        ...prev,
        {
          attempt: prev.length + 1,
          success: true,
          latency,
        },
      ]);
    } catch (err: any) {
      log("Subscribe error: " + (err?.message || err));
      setSubscribeResults((prev) => [
        ...prev,
        {
          attempt: prev.length + 1,
          success: false,
          error: err?.message || String(err),
        },
      ]);
    }
  };

  const stopSubscribeTest = async () => {
    try {
      subscribeAbort?.abort();
      subscribeAbort = null;
      for (const sub of activeSubscriptions) {
        await sub.close();
      }
      activeSubscriptions = [];
      if (videoDecoder && videoDecoder.state !== "closed") {
        videoDecoder.close();
      }
      videoDecoder = null;
      if (subConnection) {
        subConnection.close();
        subConnection = null;
      }
      if (canvasEl && canvasCtx) {
        canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      }
      setSubscribing(false);
      log("Subscribe stopped");
    } catch {
      log("Stop subscribe error");
    }
  };

  const runSmokeTest = async () => {
    if (attempts() <= 0) {
      alert("Attempts must be greater than 0");
      return;
    }

    setRunning(true);
    setLogs([]);
    setConnectionResults([]);

    const newResults: Result[] = [];

    for (let i = 1; i <= attempts(); i++) {
      const result = await runSingleTest(i);
      newResults.push(result);
      setConnectionResults([...newResults]);
      await sleep(sleepMs());
    }

    const success = newResults.filter((r) => r.success).length;
    const fail = attempts() - success;

    log("---- SUMMARY ----");
    log(`Success: ${success}`);
    log(`Fail: ${fail}`);
    log(`Failure rate: ${Math.round((fail / attempts()) * 100)}%`);

    setRunning(false);
  };

  const successCount = () =>
    connectionResults().filter((r) => r.success).length;
  const failCount = () => connectionResults().filter((r) => !r.success).length;

  return (
    <div class="min-h-screen bg-slate-900 text-slate-200 font-mono p-10">
      <div class="max-w-6xl mx-auto space-y-6">
        <h1 class="text-3xl font-semibold">MOQT Dev Dashboard</h1>

        <div class="bg-slate-800 rounded-2xl p-6 shadow-lg">
          <h2 class="text-xl font-semibold mb-6">Configuration Connection</h2>

          <div class="grid md:grid-cols-3 gap-6">
            <div>
              <label class="block text-sm mb-2 text-slate-400">
                Relay URL (base URL)
              </label>
              <select
                value={relayUrl()}
                disabled={running()}
                onChange={(e) => {
                  const val = e.currentTarget.value;
                  setRelayUrl(val);
                  localStorage.setItem("moq-relay-url", val);
                  window.location.reload();
                }}
                class="w-full px-4 py-2 rounded-lg bg-slate-900 border border-slate-700 focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              >
                <option value="http://localhost:4443">http://localhost:4443</option>
                <option value="https://hk.nofilter.io">https://hk.nofilter.io</option>
                <option value="https://usc.cdn.moq.dev">https://usc.cdn.moq.dev</option>
              </select>
            </div>

            <div>
              <label class="block text-sm mb-2 text-slate-400">
                Connection Attempts
              </label>
              <input
                type="number"
                value={attempts()}
                disabled={running()}
                onInput={(e) => setAttempts(Number(e.currentTarget.value))}
                class="w-full px-4 py-2 rounded-lg bg-slate-900 border border-slate-700 focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              />
            </div>

            <div>
              <label class="block text-sm mb-2 text-slate-400">
                Connection Sleep Between Attempts (ms)
              </label>
              <input
                type="number"
                value={sleepMs()}
                disabled={running()}
                onInput={(e) => setSleepMs(Number(e.currentTarget.value))}
                class="w-full px-4 py-2 rounded-lg bg-slate-900 border border-slate-700 focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              />
            </div>
          </div>

          <h2 class="text-lg font-semibold my-4">Relay Path Configuration</h2>
          <div>
            <label class="block text-sm mb-2 text-slate-400">
              Path (shared pub/sub path)
            </label>
            <input
              type="text"
              value={relayPath()}
              onInput={(e) => setRelayPath(e.currentTarget.value)}
              class="w-full px-4 py-2 rounded-lg bg-slate-900 border border-slate-700"
            />
          </div>

          <div class="flex gap-4 mt-6 flex-wrap">
            <button
              onClick={runSmokeTest}
              disabled={running()}
              class={`px-6 py-2 rounded-lg font-semibold transition ${
                running()
                  ? "bg-slate-600 cursor-not-allowed"
                  : "bg-blue-600 hover:bg-blue-700"
              }`}
            >
              {running() ? "Running..." : "Start Connection Test"}
            </button>

            <button
              onClick={runSchemeExperiment}
              disabled={schemeTesting()}
              class={`px-6 py-2 rounded-lg font-semibold transition ${
                schemeTesting()
                  ? "bg-slate-600 cursor-not-allowed"
                  : "bg-amber-600 hover:bg-amber-700"
              }`}
            >
              {schemeTesting() ? "Testing Schemes..." : "Run Scheme Test"}
            </button>

            <button
              onClick={() => {
                if (publishing()) {
                  stopPublishTest();
                } else {
                  startPublishTest();
                }
              }}
              class={`px-6 py-2 rounded-lg font-semibold transition ${
                publishing()
                  ? "bg-red-600 hover:bg-red-700"
                  : "bg-green-600 hover:bg-green-700"
              }`}
            >
              {publishing() ? "Stop Publish" : "Start Publish"}
            </button>

            <button
              onClick={() => {
                if (subscribing()) {
                  stopSubscribeTest();
                } else {
                  startSubscribeTest();
                }
              }}
              class={`px-6 py-2 rounded-lg font-semibold transition ${
                subscribing()
                  ? "bg-gray-600 hover:bg-gray-700"
                  : "bg-purple-600 hover:bg-purple-700"
              }`}
            >
              {subscribing() ? "Stop Subscribe" : "Start Subscribe"}
            </button>
          </div>
        </div>

        <div class="bg-slate-800 rounded-2xl p-6 shadow-lg">
          <h2 class="text-xl font-semibold mb-4 flex items-center justify-between">
            <span>Connection Results</span>
            <div class="flex gap-3 text-sm">
              <span class="bg-green-600 px-3 py-1 rounded-full">
                Success: {successCount()}
              </span>
              <span class="bg-red-600 px-3 py-1 rounded-full">
                Fail: {failCount()}
              </span>
            </div>
          </h2>

          <div class="bg-slate-900 p-4 rounded-xl border border-slate-700 max-h-64 overflow-auto text-xs">
            {connectionResults().length === 0 ? (
              <div class="text-slate-400 italic">No connection tests yet.</div>
            ) : (
              <pre>{JSON.stringify(connectionResults(), null, 2)}</pre>
            )}
          </div>
        </div>

        <div class="bg-slate-800 rounded-2xl p-6 shadow-lg">
          <h2 class="text-xl font-semibold mb-4 flex items-center justify-between">
            <span>Publish Results</span>
            <div class="flex gap-3 text-sm">
              <span class="bg-green-600 px-3 py-1 rounded-full">
                Success: {publishResults().filter((r) => r.success).length}
              </span>
              <span class="bg-red-600 px-3 py-1 rounded-full">
                Fail: {publishResults().filter((r) => !r.success).length}
              </span>
            </div>
          </h2>

          <div class="bg-slate-900 p-4 rounded-xl border border-slate-700 max-h-64 overflow-auto text-xs">
            {publishResults().length === 0 ? (
              <div class="text-slate-400 italic">No publish tests yet.</div>
            ) : (
              <pre>{JSON.stringify(publishResults(), null, 2)}</pre>
            )}
          </div>
        </div>

        <div class="bg-slate-800 rounded-2xl p-6 shadow-lg">
          <h2 class="text-xl font-semibold mb-4 flex items-center justify-between">
            <span>Subscribe Results</span>
            <div class="flex gap-3 text-sm">
              <span class="bg-green-600 px-3 py-1 rounded-full">
                Success: {subscribeResults().filter((r) => r.success).length}
              </span>
              <span class="bg-red-600 px-3 py-1 rounded-full">
                Fail: {subscribeResults().filter((r) => !r.success).length}
              </span>
            </div>
          </h2>

          <div class="bg-slate-900 p-4 rounded-xl border border-slate-700 max-h-64 overflow-auto text-xs">
            {subscribeResults().length === 0 ? (
              <div class="text-slate-400 italic">No subscribe tests yet.</div>
            ) : (
              <pre>{JSON.stringify(subscribeResults(), null, 2)}</pre>
            )}
          </div>
        </div>

        <div class="bg-slate-800 rounded-2xl p-6 shadow-lg">
          <h2 class="text-xl font-semibold mb-4">Live Subscribe Video</h2>

          <canvas
            ref={(el) => (canvasEl = el)}
            width={640}
            height={480}
            class="w-full rounded-xl bg-black"
          />
        </div>

        <div class="bg-slate-800 rounded-2xl p-6 shadow-lg">
          <h2 class="text-xl font-semibold mb-4">Logs</h2>

          <div class="bg-slate-900 p-4 rounded-xl border border-slate-700 max-h-80 overflow-auto text-xs leading-relaxed">
            {logs().length === 0 ? (
              <div class="text-slate-400 italic">No logs yet.</div>
            ) : (
              <pre>{logs().join("\n")}</pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
