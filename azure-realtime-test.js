import "dotenv/config";

const endpointEnv = (process.env.AZURE_OPENAI_ENDPOINT || "").replace(/\/$/, "");
const apiKey = process.env.AZURE_OPENAI_API_KEY || "";
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "";
const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-10-01-preview";

if (!endpointEnv || !apiKey || !deployment) {
  console.error("Missing one of AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT");
  process.exit(1);
}

const endpointsToTry = [endpointEnv];
if (endpointEnv.includes(".cognitiveservices.azure.com")) {
  const alt = endpointEnv.replace(".cognitiveservices.azure.com", ".openai.azure.com");
  if (alt !== endpointEnv) endpointsToTry.push(alt);
}

// Try multiple patterns (Azure docs are evolving)
const urlPatterns = [
  (ep) => { // documented by user: /realtime/<deployment>
    const u = new URL(`/openai/realtime/${deployment}`, `${ep}/`);
    u.searchParams.set("api-version", apiVersion);
    return u;
  },
  (ep) => { // query deployment
    const u = new URL("/openai/realtime", `${ep}/`);
    u.searchParams.set("api-version", apiVersion);
    u.searchParams.set("deployment", deployment);
    return u;
  },
  (ep) => { // fallback legacy-ish
    const u = new URL(`/openai/deployments/${deployment}/realtime`, `${ep}/`);
    u.searchParams.set("api-version", apiVersion);
    return u;
  }
];

async function testMinimalPost(targetUrl) {
  const res = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: deployment || "gpt-realtime-mini" })
  });

  const text = await res.text();
  console.log("Minimal POST status:", res.status);
  console.log("Minimal POST body (truncated):", text.slice(0, 600));
  if (!res.ok) {
    throw new Error(`Minimal POST failed ${res.status}`);
  }
}

async function getClientSecret(targetBaseUrl) {
  const sessionConfig = {
    session: {
      type: "realtime",
      model: deployment || "gpt-realtime-mini",
      audio: {
        output: { voice: "sage" }
      },
      turn_detection: {
        type: "semantic_vad",
        eagerness: "medium"
      },
      input_audio_transcription: {
        model: "whisper-1",
        language: "en"
      }
    }
  };

  const clientSecretUrl = new URL(targetBaseUrl);
  clientSecretUrl.pathname += "/client_secrets";

  const res = await fetch(clientSecretUrl, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      "OpenAI-Beta": "realtime=v1"
    },
    body: JSON.stringify(sessionConfig)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Client secret request failed ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data;
}

// Optional helper to test server-side SDP negotiation once you have an SDP offer string.
async function negotiateSession(offerSdp) {
  if (!offerSdp) throw new Error("Missing SDP offer string");

  const callsUrl = urlPatterns[0](endpointsToTry[0]);
  callsUrl.pathname += "/calls";

  const res = await fetch(callsUrl, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/sdp",
      "OpenAI-Beta": "realtime=v1"
    },
    body: offerSdp
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Negotiation failed ${res.status}: ${text}`);
  }

  return res.text();
}

async function wsSmokeTest(ep) {
  const wssUrl = new URL("/openai/realtime", ep.replace(/^http/, "ws"));
  wssUrl.searchParams.set("api-version", apiVersion);
  wssUrl.searchParams.set("deployment", deployment);
  wssUrl.searchParams.set("api-key", apiKey);

  if (typeof WebSocket === "undefined") {
    console.log("WebSocket not available in this Node runtime; skipping WS smoke test.");
    return;
  }

  console.log("Trying WebSocket:", wssUrl.toString());
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wssUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket timeout"));
    }, 5000);

    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      console.log("WebSocket open ✔");
      ws.close();
      resolve();
    });
    ws.addEventListener("error", (err) => {
      clearTimeout(timeout);
      reject(err?.error || err);
    });
  });
}

async function main() {
  console.log("Testing Azure OpenAI Realtime client secret...");
  console.log("Deployment:", deployment);
  console.log("API version:", apiVersion);

  for (const endpoint of endpointsToTry) {
    console.log("Trying endpoint:", endpoint);

    for (const pattern of urlPatterns) {
      const targetUrl = pattern(endpoint);
      console.log("Testing URL:", targetUrl.toString());

      await testMinimalPost(targetUrl).catch((err) => {
        console.error("Minimal POST failed:", err.message);
      });

      try {
        const secret = await getClientSecret(targetUrl);
        console.log("Client secret response (truncated):");
        console.log(JSON.stringify(secret, null, 2).slice(0, 800));
        console.log("Success. Use the 'client_secret' value in your frontend or the 'negotiation_token' in a server flow.");
        return;
      } catch (err) {
        console.error("Client secret call failed (Azure may not expose /client_secrets):", err.message);
      }
    }

    await wsSmokeTest(endpoint).catch((err) => {
      console.error("WebSocket smoke test failed:", err.message || err);
    });
  }

  // To test server-side negotiation, call negotiateSession(yourOfferSdp).
  // Example:
  // const answerSdp = await negotiateSession(offerSdpString);
  // console.log(answerSdp.slice(0, 400));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
