import { Component, createSignal } from "solid-js";

type Result = {
  attempt: number;
  success: boolean;
  latency?: number;
  error?: string;
};

export const TestCall3: Component = () => {
  const [relayUrl, setRelayUrl] = createSignal(
    "https://us-east-1.relay.sylvan-b.com/"
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
  let mediaRecorder: MediaRecorder | null = null;
  let wt: WebTransport | null = null;
  let subWt: WebTransport | null = null;
  let videoEl: HTMLVideoElement | undefined;
  let mediaSource: MediaSource | null = null;
  let sourceBuffer: SourceBuffer | null = null;
  let bufferQueue: Uint8Array[] = [];
  let streamReceived = false;
  let publishWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;

  const [subscribing, setSubscribing] = createSignal(false);

  const appendNext = () => {
    if (!sourceBuffer) return;
    if (sourceBuffer.updating) return;
    if (bufferQueue.length === 0) return;

    const chunk = bufferQueue.shift()!;
    try {
      sourceBuffer.appendBuffer(chunk);
    } catch (e) {
      log("appendBuffer error: " + e);
    }
  };

  const log = (msg: string) => {
    console.log(msg);
    setLogs((prev) => [...prev, msg]);
  };

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const relayTarget = () => {
    const base = relayUrl().endsWith("/") ? relayUrl() : `${relayUrl()}/`;
    return `${base}${relayPath()}`;
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
    log(`Attempt #${attempt} — starting`);

    try {
      if (typeof WebTransport === "undefined") {
        throw new Error("WebTransport unsupported");
      }

      const wt = new WebTransport(relayUrl());

      await Promise.race([
        wt.ready,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("READY TIMEOUT")), 5000)
        ),
      ]);

      const latency = performance.now() - start;

      log(`Attempt #${attempt} — SUCCESS (${Math.round(latency)} ms)`);

      wt.close();

      return {
        attempt,
        success: true,
        latency,
      };
    } catch (err: any) {
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

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });

      log("Connecting to relay...");

      wt = new WebTransport(relayTarget());

      await wt.ready;

      const latency = performance.now() - start;
      log("WebTransport ready");

      const transportStream = await wt.createUnidirectionalStream();
      const publishWriter = transportStream.getWriter();

      mediaRecorder = new MediaRecorder(stream, {
        mimeType: "video/webm;codecs=vp8,opus",
      });

      mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0) {
          const buffer = await event.data.arrayBuffer();
          await publishWriter.write(new Uint8Array(buffer));
          log(`Sent chunk: ${buffer.byteLength} bytes`);
        }
      };

      mediaRecorder.start(200);
      setPublishing(true);

      log("Publishing started");
      setPublishResults((prev) => [
        ...prev,
        {
          attempt: prev.length + 1,
          success: true,
          latency,
        },
      ]);
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
      mediaRecorder?.stop();
      await publishWriter?.close();
      publishWriter = null;
      wt?.close();
      setPublishing(false);
      log("Publishing stopped");
    } catch (err) {
      log("Stop error");
    }
  };

  const startSubscribeTest = async () => {
    const start = performance.now();
    streamReceived = false;

    try {
      if (typeof WebTransport === "undefined") {
        throw new Error("WebTransport unsupported");
      }

      log("Connecting for subscribe...");
      subWt = new WebTransport(relayTarget());

      await subWt.ready;
      mediaSource = new MediaSource();
      if (!videoEl) {
        log("Video element not ready");
        return;
      }
      videoEl!.src = URL.createObjectURL(mediaSource);
      videoEl.onloadedmetadata = () => log("Video metadata loaded");
      videoEl.oncanplay = () => log("Video can play");
      videoEl.onerror = (e) => log("Video error fired");
      mediaSource.addEventListener("sourceopen", () => {
        try {
          sourceBuffer = mediaSource!.addSourceBuffer(
            'video/webm; codecs="vp8,opus"'
          );

          sourceBuffer.mode = "segments";

          sourceBuffer.addEventListener("updateend", () => {
            appendNext();
          });

          appendNext();
        } catch (e) {
          log("SourceBuffer error: " + e);
        }
      });

      const latency = performance.now() - start;

      log("Subscribe transport ready");
      setSubscribing(true);

      const timeout = setTimeout(() => {
        if (!streamReceived) {
          log("❌ Subscribe failed: no incoming stream");

          setSubscribeResults((prev) => [
            ...prev,
            {
              attempt: prev.length + 1,
              success: false,
              error: "No incoming stream",
            },
          ]);
        }
      }, 3000);

      // Listen incoming media streams
      (async () => {
        for await (const stream of subWt!.incomingUnidirectionalStreams) {
          streamReceived = true;
          clearTimeout(timeout);
          log("Incoming media stream received");

          const reader = stream.getReader();

          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              log("Media stream ended");
              break;
            }

            if (value) {
              bufferQueue.push(value);
              appendNext();
              log(`Received media chunk: ${value.length} bytes`);
            }
          }
        }

        setSubscribeResults((prev) => [
          ...prev,
          {
            attempt: prev.length + 1,
            success: true,
            latency,
          },
        ]);
      })();
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
      subWt?.close();
      subWt = null;
      bufferQueue = [];
      sourceBuffer = null;
      if (mediaSource) mediaSource.endOfStream();
      mediaSource = null;
      if (videoEl) videoEl.src = "";
      setSubscribing(false);
      log("Subscribe stopped");
    } catch {
      log("Stop subscribe error");
    }
  };

  const runSmokeTest = async () => {
    if (!relayUrl().startsWith("https://")) {
      alert("Relay URL must start with https://");
      return;
    }

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
        <h1 class="text-3xl font-semibold">WebTransport Dev Dashboard</h1>

        <div class="bg-slate-800 rounded-2xl p-6 shadow-lg">
          <h2 class="text-xl font-semibold mb-6">Configuration Connection</h2>

          <div class="grid md:grid-cols-3 gap-6">
            <div>
              <label class="block text-sm mb-2 text-slate-400">
                Relay URL (base URL)
              </label>
              <input
                type="text"
                value={relayUrl()}
                disabled={running()}
                onInput={(e) => setRelayUrl(e.currentTarget.value)}
                class="w-full px-4 py-2 rounded-lg bg-slate-900 border border-slate-700 focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              />
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

          <video
            ref={(el) => (videoEl = el)}
            autoplay
            muted
            controls
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
