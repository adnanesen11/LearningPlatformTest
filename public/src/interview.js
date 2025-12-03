// Extract session ID from URL
const pathParts = window.location.pathname.split('/');
const interviewSessionId = pathParts[pathParts.length - 1];

// DOM elements
const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');
const liveIndicator = document.getElementById('live-indicator');
const chatContainer = document.getElementById('chat-container');
const cameraFeed = document.getElementById('camera-feed');
const cameraStatus = document.getElementById('camera-status');
const videoOverlay = document.getElementById('video-overlay');
const timerText = document.getElementById('timer-text');

// State variables
let peerConnection = null;
let dataChannel = null;
let audioElement = null;
let cameraStream = null;
let candidateAudioStream = null;
let assistantAudioStream = null;
let combinedRecorder = null;
let combinedChunks = [];
let combinedRecordingStopped = null;
let audioContext = null;
let isSessionActive = false;
let sessionPrompt = '';
let sessionDetails = null;
let hasSentGreeting = false;
const VAD_CONFIG = {
    // type: 'server_vad',
    // silence_duration_ms: 1500
    type: 'semantic_vad',
    eagerness: 'medium'
};

// Pricing constants (USD, per 1M tokens unless noted)
const PRICING_RATES = {
    model: 'gpt-realtime-mini',
    text: {
        input: 0.6,
        cachedInput: 0.06,
        output: 2.4
    },
    audio: {
        input: 10.0,
        cachedInput: 0.3,
        output: 20.0
    },
    whisperPerMinute: 0.006 // Whisper-1 per minute of user speech
};

// Stopwatch (soft budget: 15m target)
const INTERVIEW_TARGET_SECONDS = 15 * 60;
const SOFT_WARNING_SECONDS = 5 * 60;
const SOFT_ALERT_SECONDS = 15 * 60;
let stopwatchInterval = null;
let stopwatchElapsedSeconds = 0;
let lastTickTimestamp = null;
let alreadyEnded = false;
let pendingEndInterview = false;
let outputAudioActive = false;
let lastAssistantResponseId = null;

// Token and cost tracking
const tokenUsage = {
    response: {
        textInput: 0,
        audioInput: 0,
        textOutput: 0,
        audioOutput: 0,
        cachedTextInput: 0,
        cachedAudioInput: 0,
        seenResponseIds: new Set()
    },
    transcription: {
        totalTokens: 0,
        audioTokens: 0
    },
    speechDurationSeconds: 0
};
let speechStartTimestamp = null;
let userSpeaking = false;
let pendingTranscriptSave = null;

// Initialize session
async function initializeSession() {
    if (!interviewSessionId || interviewSessionId === 'interview') {
        showError('Invalid interview link');
        return;
    }

    try {
        // Fetch session details
        const response = await fetch(`/api/session/${interviewSessionId}`);
        if (!response.ok) {
            throw new Error('Interview session not found');
        }

        const session = await response.json();
        sessionPrompt = session.systemPrompt;
        sessionDetails = session;
        hasSentGreeting = false;

        // Initialize camera
        await initCamera();

        startButton.disabled = false;
    } catch (error) {
        console.error('Error loading interview session:', error);
        showError(error.message);
    }
}

// Initialize camera
async function initCamera() {
    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: false
        });

        cameraFeed.srcObject = cameraStream;
        cameraFeed.classList.add('active');
        videoOverlay.classList.add('hidden');
        cameraStatus.innerHTML = '<span class="camera-icon">dY"1</span><span>Active</span>';
    } catch (error) {
        console.error('Camera access error:', error);
        cameraStatus.innerHTML = '<span class="camera-icon">dY"1</span><span>Camera unavailable</span>';
    }
}

async function negotiateWithServer(sdp) {
    const response = await fetch('/session', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/sdp'
        },
        body: sdp
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Server negotiation failed (${response.status}): ${errorText}`);
    }

    return response.text();
}

async function negotiateDirectly(sdp) {
    const tokenResponse = await fetch('/token');
    if (!tokenResponse.ok) {
        throw new Error('Failed to fetch ephemeral token');
    }

    const data = await tokenResponse.json();
    const EPHEMERAL_KEY = data?.client_secret?.value || data?.value;
    if (!EPHEMERAL_KEY) {
        throw new Error('Token response missing client secret');
    }

    const baseUrl = "https://api.openai.com/v1/realtime/calls";
    const model = "gpt-realtime-mini";
    const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: sdp,
        headers: {
            Authorization: `Bearer ${EPHEMERAL_KEY}`,
            "Content-Type": "application/sdp",
            "OpenAI-Beta": "realtime=v1",
        },
    });

    if (!sdpResponse.ok) {
        const errorText = await sdpResponse.text();
        throw new Error(errorText || 'Realtime API negotiation failed');
    }

    return sdpResponse.text();
}

async function getSdpAnswer(sdp) {
    try {
        return await negotiateWithServer(sdp);
    } catch (serverError) {
        console.warn('Server negotiation failed, falling back to direct negotiation', serverError);
        return await negotiateDirectly(sdp);
    }
}

// Start interview session (using original working approach)
async function startInterview() {
    try {
        startButton.disabled = true;
        liveIndicator.textContent = 'CONNECTING...';

        hasSentGreeting = false;
        currentAssistantItemId = null;
        currentUserItemId = null;
        alreadyEnded = false;
        stopwatchElapsedSeconds = 0;
        pendingEndInterview = false;
        outputAudioActive = false;
        lastAssistantResponseId = null;

        const pc = new RTCPeerConnection();
        peerConnection = pc;

        audioElement = document.createElement('audio');
        audioElement.autoplay = true;
        pc.ontrack = (e) => {
            audioElement.srcObject = e.streams[0];
            console.log('Receiving audio track');
            if (!assistantAudioStream) {
                assistantAudioStream = e.streams[0];
                tryStartCombinedRecording();
            }
        };

        const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
        candidateAudioStream = ms;
        pc.addTrack(ms.getTracks()[0]);

        const dc = pc.createDataChannel('oai-events');
        dataChannel = dc;

        dc.addEventListener('open', () => {
            console.log('Data channel opened');
            isSessionActive = true;
            liveIndicator.textContent = 'LIVE';
            stopButton.disabled = false;
            tryStartCombinedRecording();

            sendEvent({
                type: 'session.update',
                session: {
                    instructions: sessionPrompt,
                    turn_detection: VAD_CONFIG,
                    voice: 'sage',
                    input_audio_transcription: {
                        model: 'whisper-1',
                        language: 'en'
                    },
                    tools: [
                        {
                            type: 'function',
                            name: 'end_interview',
                            description: 'Signal that the interview is complete and the assistant should stop. Include an optional reason.',
                            parameters: {
                                type: 'object',
                                properties: {
                                    reason: {
                                        type: 'string',
                                        description: 'Brief note on why the interview is ending.'
                                    }
                                }
                            }
                        }
                    ]
                }
            });

            startStopwatch();
            triggerInitialGreeting();
        });

        dc.addEventListener('message', (e) => {
            const event = JSON.parse(e.data);
            handleServerEvent(event);
        });

        dc.addEventListener('close', () => {
            console.log('Data channel closed');
        });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const remoteSdp = await getSdpAnswer(offer.sdp);
        const answer = { type: 'answer', sdp: remoteSdp };
        await pc.setRemoteDescription(answer);

    } catch (error) {
        console.error('Error starting interview:', error);
        showError('Failed to start interview: ' + error.message);
        startButton.disabled = false;
        liveIndicator.textContent = 'READY';
        hasSentGreeting = false;
    }
}

// Stop interview session
async function stopInterview() {
    if (alreadyEnded) {
        return;
    }
    alreadyEnded = true;
    if (dataChannel) {
        dataChannel.close();
        dataChannel = null;
    }

    if (peerConnection) {
        peerConnection.getSenders().forEach((sender) => {
            if (sender.track) {
                sender.track.stop();
            }
        });
        peerConnection.close();
        peerConnection = null;
    }

    await stopCombinedRecording();

    stopStopwatch();

    isSessionActive = false;
    startButton.disabled = false;
    stopButton.disabled = true;
    liveIndicator.textContent = 'ENDED';
    hasSentGreeting = false;
    currentAssistantItemId = null;
    currentUserItemId = null;
    pendingEndInterview = false;
    outputAudioActive = false;
    lastAssistantResponseId = null;

    // Finalize speech duration if someone was mid-turn
    if (userSpeaking && speechStartTimestamp) {
        const deltaSeconds = (Date.now() - speechStartTimestamp) / 1000;
        tokenUsage.speechDurationSeconds += Math.max(deltaSeconds, 0);
        userSpeaking = false;
        speechStartTimestamp = null;
    }

    logCostSummary();
    saveTranscriptAndAnalysis();
    addSystemMessage('Interview session ended');
}

// Send event to OpenAI
function sendEvent(event) {
    if (dataChannel && dataChannel.readyState === 'open') {
        console.log('Sending event:', event.type);
        dataChannel.send(JSON.stringify(event));
    }
}

function triggerInitialGreeting() {
    if (hasSentGreeting) {
        return;
    }

    const candidateName = sessionDetails?.candidateName?.trim();
    const jobTitle = sessionDetails?.jobTitle?.trim();
    const greetingTarget = candidateName || 'the candidate';
    const roleContext = jobTitle ? ` for the ${jobTitle} role` : '';

    sendEvent({
        type: "response.create",
        response: {
                            instructions: `Begin the interview by greeting ${greetingTarget}${roleContext}. Introduce yourself as the AI interviewer, and smoothly transition into the first question. Respond in English only, regardless of the candidate's language.`
        }
    });

    hasSentGreeting = true;
}

// Handle server events
function handleServerEvent(event) {
    console.log('Received event:', event.type, event);

    switch (event.type) {
        case 'conversation.item.created': {
            const item = event.item;
            if (!item?.id || !item?.role) {
                break;
            }

            const content = item.content?.find?.(c => c.type === 'text');
            upsertMessage(item.id, item.role, content?.text || '');

            if (item.role === 'assistant') {
                currentAssistantItemId = item.id;
                currentUserItemId = null;
            } else if (item.role === 'user') {
                currentUserItemId = item.id;
            }
            break;
        }

        case 'response.created': {
            const respId = event.response?.id;
            if (respId) {
                lastAssistantResponseId = respId;
            }
            break;
        }

        case 'response.audio_transcript.delta': {
            const targetId = event.item_id || currentAssistantItemId || `assistant-${event.response_id || Date.now()}`;
            if (event.delta) {
                currentAssistantItemId = targetId;
                appendToMessage(targetId, 'assistant', event.delta);
                currentUserItemId = null;
            }
            break;
        }

        case 'response.audio_transcript.done': {
            const targetId = event.item_id || currentAssistantItemId || `assistant-${event.response_id || Date.now()}`;
            if (event.transcript) {
                upsertMessage(targetId, 'assistant', event.transcript);
                currentAssistantItemId = null;
                currentUserItemId = null;
            }
            break;
        }

        case 'response.text.done': {
            const targetId = event.item_id || currentAssistantItemId || `assistant-${event.response_id || Date.now()}`;
            if (typeof event.text === 'string') {
                upsertMessage(targetId, 'assistant', event.text);
                currentAssistantItemId = null;
                currentUserItemId = null;
            }
            break;
        }

        case 'conversation.item.input_audio_transcription.delta':
            if (event.item_id && event.delta) {
                currentUserItemId = event.item_id;
                appendToMessage(event.item_id, 'user', event.delta);
            }
            break;

        case 'conversation.item.input_audio_transcription.completed':
            if (event.item_id && event.transcript) {
                currentUserItemId = event.item_id;
                upsertMessage(event.item_id, 'user', event.transcript);
            }
            if (event.usage) {
                const total = event.usage.total_tokens ?? 0;
                const audioTokens = event.usage.input_token_details?.audio_tokens ?? 0;
                tokenUsage.transcription.totalTokens += total;
                tokenUsage.transcription.audioTokens += audioTokens;
            }
            break;

        case 'response.done': {
            const respId = event.response?.id;
            if (respId && tokenUsage.response.seenResponseIds.has(respId)) {
                break; // dedupe repeated response.done
            }
            if (respId) {
                tokenUsage.response.seenResponseIds.add(respId);
            }

            const usage = event.response?.usage;
            if (usage) {
                const textIn = usage.input_token_details?.text_tokens ?? 0;
                const audioIn = usage.input_token_details?.audio_tokens ?? 0;
                const textOut = usage.output_token_details?.text_tokens ?? 0;
                const audioOut = usage.output_token_details?.audio_tokens ?? 0;

                const cachedTotal = usage.input_token_details?.cached_tokens ?? 0;
                const cachedAudio = usage.input_token_details?.cached_tokens_details?.audio_tokens ?? 0;
                const cachedText = usage.input_token_details?.cached_tokens_details?.text_tokens ?? Math.max(cachedTotal - cachedAudio, 0);

                const nonCachedText = Math.max(textIn - cachedText, 0);
                const nonCachedAudio = Math.max(audioIn - cachedAudio, 0);

                tokenUsage.response.cachedTextInput += cachedText;
                tokenUsage.response.cachedAudioInput += cachedAudio;
                tokenUsage.response.textInput += nonCachedText;
                tokenUsage.response.audioInput += nonCachedAudio;
                tokenUsage.response.textOutput += textOut;
                tokenUsage.response.audioOutput += audioOut;
            }
            const output = event.response?.output;
            if (Array.isArray(output)) {
                const fnCall = output.find(o => o.type === 'function_call' && o.name === 'end_interview');
                if (fnCall && !alreadyEnded) {
                    console.log('Function call received: end_interview', fnCall);
                    pendingEndInterview = true;
                    // If no audio is playing, we can end immediately; otherwise wait for stop event
                    if (!outputAudioActive) {
                        stopInterview();
                    }
                }
            }
            break;
        }

        case 'output_audio_buffer.started':
            outputAudioActive = true;
            break;

        case 'output_audio_buffer.stopped':
            outputAudioActive = false;
            if (pendingEndInterview && !alreadyEnded) {
                stopInterview();
            }
            break;

        case 'input_audio_buffer.speech_started':
            userSpeaking = true;
            speechStartTimestamp = Date.now();
            break;

        case 'input_audio_buffer.speech_stopped':
            if (userSpeaking && speechStartTimestamp) {
                const deltaSeconds = (Date.now() - speechStartTimestamp) / 1000;
                tokenUsage.speechDurationSeconds += Math.max(deltaSeconds, 0);
            }
            speechStartTimestamp = null;
            userSpeaking = false;
            break;

        case 'error':
            console.error('Server error:', event.error);
            showError(event.error.message || 'An error occurred');
            break;
    }
}

// Chat UI functions
const messageElements = new Map();
const messageTextCache = new Map();
let currentAssistantItemId = null;
let currentUserItemId = null;

function createMessageElement(role) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${role}`;
    messageDiv.dataset.role = role;

    const roleLabel = document.createElement('div');
    roleLabel.className = 'role-label';
    roleLabel.textContent = role.toUpperCase();
    messageDiv.appendChild(roleLabel);

    const content = document.createElement('div');
    content.className = 'message-content';
    messageDiv.appendChild(content);

    chatContainer.appendChild(messageDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    return messageDiv;
}

function getMessageElement(itemId, role) {
    if (!itemId) {
        return createMessageElement(role);
    }

    const existing = messageElements.get(itemId);
    if (existing) {
        return existing;
    }

    const messageDiv = createMessageElement(role);
    messageDiv.dataset.itemId = itemId;

    messageElements.set(itemId, messageDiv);
    return messageDiv;
}

function upsertMessage(itemId, role, text) {
    if (!itemId) {
        return;
    }

    const messageDiv = getMessageElement(itemId, role);
    const contentDiv = messageDiv.querySelector('.message-content');

    const existing = messageTextCache.get(itemId) || '';

    if (text && text.length) {
        if (text.length >= existing.length || !existing.length) {
            contentDiv.textContent = text;
            messageTextCache.set(itemId, text);
        }
        messageDiv.classList.remove('pending');
    } else if (!existing.length) {
        contentDiv.textContent = role === 'user' ? 'Transcribing...' : '';
        messageDiv.classList.add('pending');
    }

    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function appendToMessage(itemId, role, delta) {
    if (!itemId || !delta) {
        return;
    }

    const messageDiv = getMessageElement(itemId, role);
    const contentDiv = messageDiv.querySelector('.message-content');
    const existing = messageTextCache.get(itemId) || '';
    const updated = existing + delta;
    contentDiv.textContent = updated;
    messageTextCache.set(itemId, updated);
    if (delta && delta.length) {
        messageDiv.classList.remove('pending');
    }
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function addSystemMessage(text) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message system';
    messageDiv.textContent = text;
    chatContainer.appendChild(messageDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function showError(message) {
    addSystemMessage('Error: ' + message);
    liveIndicator.textContent = 'ERROR';
}

async function uploadMedia(kind, blob) {
    if (!interviewSessionId || !blob) {
        return;
    }
    try {
        await fetch(`/api/upload-media?sessionId=${encodeURIComponent(interviewSessionId)}&type=${encodeURIComponent(kind)}`, {
            method: 'POST',
            headers: {
                'Content-Type': blob.type || 'application/octet-stream'
            },
            body: blob
        });
    } catch (error) {
        console.error(`Failed to upload ${kind} recording:`, error);
    }
}

function tryStartCombinedRecording() {
    if (!cameraStream || !candidateAudioStream || !assistantAudioStream) {
        return;
    }
    if (combinedRecorder && combinedRecorder.state === 'recording') {
        return;
    }

    combinedChunks = [];

    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    const destination = audioContext.createMediaStreamDestination();
    const maybeConnect = (stream) => {
        if (stream) {
            const track = stream.getAudioTracks()[0];
            if (track) {
                const src = audioContext.createMediaStreamSource(new MediaStream([track]));
                src.connect(destination);
            }
        }
    };

    maybeConnect(candidateAudioStream);
    maybeConnect(assistantAudioStream);

    const mixedAudioTrack = destination.stream.getAudioTracks()[0];
    const videoTrack = cameraStream.getVideoTracks()[0];

    if (!mixedAudioTrack || !videoTrack) {
        console.warn('Missing tracks for combined recording');
        return;
    }

    const combinedStream = new MediaStream([videoTrack, mixedAudioTrack]);

    try {
        combinedRecorder = new MediaRecorder(combinedStream, { mimeType: 'video/webm;codecs=vp8,opus' });
    } catch (err) {
        console.warn('Falling back to default MediaRecorder for combined recording:', err);
        combinedRecorder = new MediaRecorder(combinedStream);
    }

    combinedRecordingStopped = new Promise((resolve) => {
        combinedRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                combinedChunks.push(event.data);
            }
        };
        combinedRecorder.onstop = async () => {
            try {
                if (combinedChunks.length > 0) {
                    const blob = new Blob(combinedChunks, { type: 'video/webm' });
                    await uploadMedia('combined', blob);
                }
            } finally {
                combinedChunks = [];
                resolve();
            }
        };
    });

    combinedRecorder.start(1000);
    console.log('Combined AV recording started');
}

async function stopCombinedRecording() {
    if (combinedRecorder && combinedRecorder.state === 'recording') {
        combinedRecorder.stop();
        if (combinedRecordingStopped) {
            await combinedRecordingStopped;
        }
    }
    combinedRecorder = null;
    combinedRecordingStopped = null;
}

// Stopwatch functions
function startStopwatch() {
    stopwatchElapsedSeconds = 0;
    lastTickTimestamp = performance.now();
    updateTimerDisplay(0);

    if (stopwatchInterval) {
        clearInterval(stopwatchInterval);
    }

    stopwatchInterval = setInterval(() => {
        const now = performance.now();
        const deltaSec = (now - lastTickTimestamp) / 1000;
        lastTickTimestamp = now;

        stopwatchElapsedSeconds += deltaSec;
        updateTimerDisplay(stopwatchElapsedSeconds);
    }, 250);
}

function stopStopwatch() {
    if (stopwatchInterval) {
        clearInterval(stopwatchInterval);
    }
    stopwatchInterval = null;
}

function updateTimerDisplay(elapsedSeconds = stopwatchElapsedSeconds) {
    const elapsed = Math.max(0, elapsedSeconds);
    const minutes = Math.floor(elapsed / 60);
    const seconds = Math.floor(elapsed % 60);
    timerText.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

    const timerBadge = document.getElementById('timer');
    if (!timerBadge) {
        return;
    }

    if (elapsed >= SOFT_ALERT_SECONDS) {
        timerBadge.style.color = 'var(--danger-color)';
    } else if (elapsed >= SOFT_WARNING_SECONDS) {
        timerBadge.style.color = 'var(--warning-color)';
    } else {
        timerBadge.style.color = 'var(--text-primary)';
    }
}


function logCostSummary() {
    const { response, transcription, speechDurationSeconds } = tokenUsage;
    const minutes = speechDurationSeconds / 60;

    // Model costs (cached billed at cached rates)
    const textInputCost = (response.textInput / 1_000_000) * PRICING_RATES.text.input;
    const cachedTextInputCost = (response.cachedTextInput / 1_000_000) * PRICING_RATES.text.cachedInput;
    const textOutputCost = (response.textOutput / 1_000_000) * PRICING_RATES.text.output;
    const audioInputCost = (response.audioInput / 1_000_000) * PRICING_RATES.audio.input;
    const cachedAudioInputCost = (response.cachedAudioInput / 1_000_000) * PRICING_RATES.audio.cachedInput;
    const audioOutputCost = (response.audioOutput / 1_000_000) * PRICING_RATES.audio.output;

    const whisperCost = minutes * PRICING_RATES.whisperPerMinute;

    const totalCost = textInputCost + cachedTextInputCost + textOutputCost + audioInputCost + cachedAudioInputCost + audioOutputCost + whisperCost;

    console.log('[CostSummary]', {
        model: PRICING_RATES.model,
        responseTokens: {
            textInput: response.textInput,
            audioInput: response.audioInput,
            textOutput: response.textOutput,
            audioOutput: response.audioOutput,
            cachedTextInput: response.cachedTextInput,
            cachedAudioInput: response.cachedAudioInput
        },
        transcriptionTokens: {
            total: transcription.totalTokens,
            audio: transcription.audioTokens
        },
        speechDurationSeconds: Number(speechDurationSeconds.toFixed(2)),
        costsUSD: {
            textInputCost: Number(textInputCost.toFixed(6)),
            cachedTextInputCost: Number(cachedTextInputCost.toFixed(6)),
            textOutputCost: Number(textOutputCost.toFixed(6)),
            audioInputCost: Number(audioInputCost.toFixed(6)),
            cachedAudioInputCost: Number(cachedAudioInputCost.toFixed(6)),
            audioOutputCost: Number(audioOutputCost.toFixed(6)),
            whisperCost: Number(whisperCost.toFixed(6)),
            totalCost: Number(totalCost.toFixed(6))
        }
    });
}

function buildTranscriptFromDom() {
    const messages = chatContainer.querySelectorAll('.message');
    const lines = [];
    messages.forEach(msg => {
        const role = msg.dataset.role || 'system';
        const content = msg.querySelector('.message-content')?.textContent?.trim() || msg.textContent.trim();
        if (content) {
            lines.push(`${role.toUpperCase()}: ${content}`);
        }
    });
    return lines.join('\n');
}

function saveTranscriptAndAnalysis() {
    if (pendingTranscriptSave) {
        return;
    }
    const transcript = buildTranscriptFromDom();
    if (!transcript || !transcript.length) {
        return;
    }
    pendingTranscriptSave = (async () => {
        try {
            await fetch(`/api/session/${encodeURIComponent(interviewSessionId)}/transcript`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain'
                },
                body: transcript
            });

            await fetch(`/api/session/${encodeURIComponent(interviewSessionId)}/analyze`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ transcript })
            });
        } catch (err) {
            console.error('Failed saving transcript/analysis:', err);
        }
    })();
}

// Event listeners
startButton.addEventListener('click', startInterview);
stopButton.addEventListener('click', stopInterview);

// Initialize when page loads
document.addEventListener('DOMContentLoaded', initializeSession);
