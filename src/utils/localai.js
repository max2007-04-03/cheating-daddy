try { require('dns').setDefaultResultOrder('ipv4first'); } catch (_) {}
const fs = require('fs');
const path = require('path');
const { getSystemPrompt } = require('./prompts');
const { sendToRenderer, initializeNewSession, saveConversationTurn, sendToGroq, sendImageToGroq, hasGroqKey } = require('./gemini');
const { getGroqApiKey, getPreferences } = require('../storage');
const {
    ensureNativeBinary,
    ensureLlamaModel,
    ensureWhisperModel,
    getAvailablePort,
    getModelsDirectory,
    startNativeServer,
    stopNativeServer,
    waitForServer,
} = require('./native-ai-runtime');

let llamaProcess = null;
let llamaBaseUrl = null;
let llamaModel = null;
let whisperProcess = null;
let whisperBaseUrl = null;
let localConversationHistory = [];
let currentSystemPrompt = null;
let isLocalActive = false;
let initializationController = null;
let llamaCacheSnapshot = new Set();

function createChannelState() {
    return {
        isSpeaking: false,
        speechBuffers: [],
        preRollBuffers: [],
        silenceFrameCount: 0,
        speechFrameCount: 0,
        resampleRemainder: Buffer.alloc(0),
    };
}

let channelStates = {
    speaker: createChannelState(),
    mic: createChannelState(),
};

let pendingTranscriptParts = [];
let pendingDispatchTimer = null;

function clearPendingDispatchTimer() {
    if (pendingDispatchTimer) {
        clearTimeout(pendingDispatchTimer);
        pendingDispatchTimer = null;
    }
}

function isAnyChannelSpeaking() {
    return Boolean(channelStates.speaker?.isSpeaking || channelStates.mic?.isSpeaking);
}

const TRAILING_INCOMPLETE_WORDS = new Set([
    // English connectors, prepositions, articles, pronouns, auxiliaries, setup verbs
    'and', 'or', 'but', 'so', 'because', 'since', 'if', 'when', 'while', 'where',
    'which', 'that', 'who', 'whom', 'whose', 'whether', 'although', 'though', 'unless',
    'until', 'before', 'after', 'to', 'for', 'in', 'on', 'at', 'with', 'by', 'from',
    'about', 'into', 'onto', 'between', 'among', 'through', 'during', 'without', 'within',
    'like', 'as', 'than', 'a', 'an', 'the', 'this', 'these', 'those', 'my', 'your',
    'his', 'her', 'its', 'our', 'their', 'some', 'any', 'every', 'each', 'no', 'not',
    'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
    'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'can', 'could', 'may',
    'might', 'must', 'what', 'how', 'why', 'say', 'suppose', 'imagine', 'assume',
    'consider', 'specifically', 'particularly', 'especially', 'called', 'named', 'using',
    // Ukrainian & Russian connectors, prepositions, pronouns, setup words
    'і', 'й', 'та', 'а', 'але', 'або', 'чи', 'якщо', 'коли', 'поки', 'тому', 'бо',
    'щоб', 'що', 'який', 'яка', 'яке', 'які', 'якого', 'яких', 'у', 'в', 'на', 'з',
    'із', 'зі', 'до', 'від', 'про', 'для', 'при', 'між', 'без', 'через', 'після',
    'перед', 'як', 'ніж', 'це', 'цей', 'ця', 'ці', 'той', 'ті', 'мій', 'твій', 'наш',
    'ваш', 'їх', 'є', 'був', 'була', 'були', 'буде', 'не', 'ні', 'но', 'или', 'если',
    'когда', 'пока', 'потому', 'так', 'чтобы', 'что', 'который', 'которая', 'которое',
    'которые', 'которого', 'которых', 'из', 'от', 'о', 'об', 'между', 'после', 'как',
    'чем', 'это', 'этот', 'эта', 'эти', 'тот', 'те', 'был', 'была', 'были', 'будет',
    'допустим', 'предположим', 'например', 'скажем', 'нехай', 'наприклад', 'скажімо', 'уявимо'
]);

const QUESTION_INDICATORS = /\b(what|how|why|when|where|which|who|whom|whose|explain|describe|tell|compare|difference|define|name|list|can you|could you|do you|does|is there|are there|will it|would it|що|як|чому|коли|де|який|яка|яке|які|розкажи|розкажіть|поясни|поясніть|назви|назвіть|різниця|чи можна|что|как|почему|когда|где|какой|какая|какие|расскажи|расскажите|объясни|объясните|назови|разница)\b/i;

const SETUP_PREFIXES = /^(okay|ok|alright|all right|well|so|now|next|first|second|let's|lets|suppose|imagine|assume|consider|say|i want|i would like|we have|there is|there are|давай|давайте|допустим|предположим|уявимо|уяви|нехай|тепер|наступне|дивіться|смотри|смотрите)\b/i;

function isIncompleteUtterance(text) {
    if (!text) return true;
    const trimmed = text.trim();
    if (!trimmed) return true;

    // 1. Explicit trailing continuation punctuation
    if (/[,;:\-—]$|\.\.\.$/.test(trimmed)) {
        return true;
    }

    const words = trimmed
        .toLowerCase()
        .replace(/[.,!?;:()'"\-—]/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);

    if (words.length === 0) return true;

    const lastWord = words[words.length - 1];

    // 2. Ends with a dangling conjunction, preposition, article, or auxiliary verb
    if (TRAILING_INCOMPLETE_WORDS.has(lastWord)) {
        return true;
    }

    // 3. Ends with a question mark and has at least 3 words (and didn't end on a dangling word) -> Complete!
    if (trimmed.endsWith('?') && words.length >= 3) {
        return false;
    }

    // 4. Very short fragment (< 5 words) without a question mark and without a clear question/imperative word
    if (words.length < 5 && !QUESTION_INDICATORS.test(trimmed)) {
        return true;
    }

    // 5. Conversational setup clause ("Let's talk about Spring.", "Suppose we have a class.") without an actual question yet
    if (!trimmed.endsWith('?') && SETUP_PREFIXES.test(trimmed) && !QUESTION_INDICATORS.test(trimmed)) {
        return true;
    }

    return false;
}

function resetAllChannelStates() {
    clearPendingDispatchTimer();
    pendingTranscriptParts = [];
    channelStates = {
        speaker: createChannelState(),
        mic: createChannelState(),
    };
}

const VAD_MODES = {
    SENSITIVE: { energyThreshold: 0.005, speechFramesRequired: 2, silenceFramesRequired: 10 },
    NORMAL: { energyThreshold: 0.006, speechFramesRequired: 2, silenceFramesRequired: 10 },
    AGGRESSIVE: { energyThreshold: 0.012, speechFramesRequired: 2, silenceFramesRequired: 8 },
    VERY_AGGRESSIVE: { energyThreshold: 0.018, speechFramesRequired: 2, silenceFramesRequired: 8 },
};

let vadConfig = VAD_MODES.NORMAL;
let lastGroqPrewarmTime = 0;

function prewarmGroqConnection() {
    const now = Date.now();
    if (now - lastGroqPrewarmTime < 20000) return;
    const groqApiKey = getGroqApiKey();
    if (!groqApiKey) return;
    lastGroqPrewarmTime = now;
    fetch('https://api.groq.com/openai/v1/models', {
        method: 'GET',
        headers: { Authorization: `Bearer ${groqApiKey}` },
    })
        .then(res => res.arrayBuffer())
        .catch(() => {});
}

function resample24kTo16k(inputBuffer, state) {
    const combined = Buffer.concat([state.resampleRemainder, inputBuffer]);
    const inputSamples = Math.floor(combined.length / 2);
    const outputSamples = Math.floor((inputSamples * 2) / 3);
    const outputBuffer = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
        const sourcePosition = (i * 3) / 2;
        const sourceIndex = Math.floor(sourcePosition);
        const fraction = sourcePosition - sourceIndex;
        const firstSample = combined.readInt16LE(sourceIndex * 2);
        const secondSample = sourceIndex + 1 < inputSamples ? combined.readInt16LE((sourceIndex + 1) * 2) : firstSample;
        const interpolated = Math.round(firstSample + fraction * (secondSample - firstSample));
        outputBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
    }

    const consumedInputSamples = Math.ceil((outputSamples * 3) / 2);
    const remainderStart = consumedInputSamples * 2;
    state.resampleRemainder = remainderStart < combined.length ? combined.slice(remainderStart) : Buffer.alloc(0);

    return outputBuffer;
}

function calculateRms(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    if (samples === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
        const sample = pcm16Buffer.readInt16LE(i * 2) / 32768;
        sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / samples);
}

function processVad(pcm16kBuffer, channelName) {
    const state = channelStates[channelName] || channelStates.speaker;
    const rms = calculateRms(pcm16kBuffer);
    const isVoice = rms > vadConfig.energyThreshold;
    const frameCopy = Buffer.from(pcm16kBuffer);

    if (!state.isSpeaking) {
        state.preRollBuffers.push(frameCopy);
        if (state.preRollBuffers.length > 5) {
            state.preRollBuffers.shift();
        }
    }

    if (isVoice) {
        state.speechFrameCount += 1;
        state.silenceFrameCount = 0;

        if (!state.isSpeaking && state.speechFrameCount >= vadConfig.speechFramesRequired) {
            state.isSpeaking = true;
            state.speechBuffers = [...state.preRollBuffers];
            state.preRollBuffers = [];
            clearPendingDispatchTimer();
            prewarmGroqConnection();
            console.log(`[LocalAI] Speech started on ${channelName} (RMS:`, rms.toFixed(4), ')');
            const statusMsg = pendingTranscriptParts.length > 0
                ? 'Listening... (continuing question)'
                : 'Listening... (speech detected)';
            sendToRenderer('update-status', statusMsg);
        }
    } else {
        state.silenceFrameCount += 1;
        state.speechFrameCount = 0;

        if (state.isSpeaking && state.silenceFrameCount >= vadConfig.silenceFramesRequired) {
            state.isSpeaking = false;
            const audioData = Buffer.concat(state.speechBuffers);
            state.speechBuffers = [];
            console.log(`[LocalAI] Speech ended on ${channelName}, accumulated`, audioData.length, 'bytes');
            sendToRenderer('update-status', 'Transcribing...');
            handleSpeechEnd(audioData);
            return;
        }
    }

    if (state.isSpeaking) {
        state.speechBuffers.push(frameCopy);
    }
}

function createWavBuffer(pcm16Buffer) {
    const header = Buffer.alloc(44);
    const byteRate = 16000 * 2;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm16Buffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm16Buffer.length, 40);

    return Buffer.concat([header, pcm16Buffer]);
}

const WHISPER_INTERVIEW_PROMPT =
    'Java Developer technical interview. Terms: OOP, Object-Oriented Programming, SOLID, encapsulation, inheritance, polymorphism, abstraction, JVM, JDK, JRE, bytecode, JIT compiler, Garbage Collector, Heap, Stack, Metaspace, OutOfMemoryError, StackOverflowError, equals, hashCode, String Pool, StringBuilder, immutable, ArrayList, LinkedList, HashMap, ConcurrentHashMap, TreeMap, Comparable, Comparator, Generics, PECS, Stream API, Optional, Runnable, Callable, volatile, synchronized, Deadlock, Spring Boot, IoC, Dependency Injection, Bean, Hibernate, JPA, N+1, SQL, JOIN, ACID, B-Tree index, JUnit, Mockito, Maven, Docker.';

function isWhisperHallucination(text) {
    if (!text) return true;
    const cleaned = text.trim().toLowerCase().replace(/[.,!?;:()'"\-]/g, '').replace(/\s+/g, ' ');
    const ignoredPhrases = [
        'thank you', 'thanks for watching', 'you', 'subtitles by', 'bye',
        'thank you for watching', 'mbc', 'subscribe', 'silence', 'so',
        'yeah', 'yes', 'no', 'okay', 'ok', 'im sorry', 'i am sorry', 'sorry',
        'uhhuh', 'mmhmm', 'right', 'sure', 'alright', 'all right', 'hello', 'hi',
        'one second', 'one moment', 'wait a second', 'let me see', 'i dont know',
        'is my name', 'thank you very much', 'thanks', 'good', 'great', 'nice',
        'can you hear me', 'yes i can hear you'
    ];
    if (ignoredPhrases.includes(cleaned) || cleaned.length < 4) {
        return true;
    }
    // Filter out non-English/non-Cyrillic script hallucinations on mumbles (e.g. Icelandic þ, ð, æ)
    if (/[þðæøå]/i.test(cleaned)) {
        return true;
    }
    return false;
}

async function transcribeWithGroq(pcm16kBuffer) {
    const groqApiKey = getGroqApiKey();
    if (!groqApiKey) {
        throw new Error('No Groq API key configured');
    }

    const wavBuffer = createWavBuffer(pcm16kBuffer);
    const prefs = getPreferences ? getPreferences() : {};
    const selectedLang = (prefs.selectedLanguage || 'en-US').toLowerCase();
    const langCode = selectedLang.startsWith('ru') ? 'ru' : selectedLang.startsWith('uk') ? 'uk' : 'en';

    const whisperModels = ['whisper-large-v3', 'whisper-large-v3-turbo'];
    let lastError = null;

    for (const modelName of whisperModels) {
        try {
            const formData = new FormData();
            formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'speech.wav');
            formData.append('model', modelName);
            formData.append('response_format', 'json');
            formData.append('temperature', '0.0');
            formData.append('language', langCode);
            formData.append('prompt', WHISPER_INTERVIEW_PROMPT);

            const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${groqApiKey}`,
                },
                body: formData,
            });

            if (!response.ok) {
                const errorText = await response.text();
                lastError = new Error(`Groq Whisper (${modelName}) HTTP ${response.status}: ${errorText}`);
                console.warn(lastError.message);
                continue;
            }

            const result = await response.json();
            return result.text?.trim() || '';
        } catch (err) {
            lastError = err;
            console.warn(`[LocalAI] Whisper model ${modelName} failed, trying fallback:`, err.message);
        }
    }

    throw lastError || new Error('All Groq Whisper models failed');
}

async function transcribeAudio(pcm16kBuffer) {
    if (hasGroqKey()) {
        try {
            console.log('[LocalAI] Transcribing with Groq Whisper (large-v3 + Java vocab)...');
            const t0 = Date.now();
            const text = await transcribeWithGroq(pcm16kBuffer);
            console.log(`[LocalAI] Groq Whisper transcribed in ${Date.now() - t0}ms:`, text);
            if (isWhisperHallucination(text)) {
                console.log('[LocalAI] Ignored filler/silence/hallucination:', text);
                return '';
            }
            return text;
        } catch (error) {
            console.error('[LocalAI] Groq Whisper error:', error.message);
            if (!whisperBaseUrl) return '';
            console.log('[LocalAI] Falling back to local whisper...');
        }
    }

    if (!whisperBaseUrl) {
        return '';
    }

    const wavBuffer = createWavBuffer(pcm16kBuffer);
    const formData = new FormData();
    formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'speech.wav');
    formData.append('response_format', 'json');
    formData.append('temperature', '0.0');

    const response = await fetch(`${whisperBaseUrl}/inference`, {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        throw new Error(`Whisper server returned HTTP ${response.status}`);
    }

    const result = await response.json();
    const text = result.text?.trim() || '';
    console.log('[LocalAI] Local Whisper Transcription:', text);
    return text;
}

function schedulePendingDispatch() {
    clearPendingDispatchTimer();
    if (!isLocalActive || pendingTranscriptParts.length === 0) return;

    if (isAnyChannelSpeaking()) {
        sendToRenderer('update-status', 'Listening... (continuing question)');
        return;
    }

    const combined = pendingTranscriptParts.join(' ').replace(/\s+/g, ' ').trim();
    const incomplete = isIncompleteUtterance(combined);
    const holdMs = incomplete ? 1700 : 300;

    if (incomplete) {
        console.log(`[LocalAI] Utterance looks incomplete ("${combined}"), holding ${holdMs}ms for continuation...`);
        sendToRenderer('update-status', 'Waiting for full question...');
    }

    pendingDispatchTimer = setTimeout(async () => {
        pendingDispatchTimer = null;
        if (!isLocalActive || pendingTranscriptParts.length === 0) return;
        if (isAnyChannelSpeaking()) {
            sendToRenderer('update-status', 'Listening... (continuing question)');
            return;
        }

        const finalQuestion = pendingTranscriptParts.join(' ').replace(/\s+/g, ' ').trim();
        pendingTranscriptParts = [];

        if (!finalQuestion || finalQuestion.length < 3) {
            sendToRenderer('update-status', 'Listening...');
            return;
        }

        try {
            sendToRenderer('update-status', 'Generating response...');
            await sendToLlama(finalQuestion);
        } catch (err) {
            console.error('[LocalAI] Dispatch error:', err);
            sendToRenderer('update-status', 'Listening...');
        }
    }, holdMs);
}

async function handleSpeechEnd(audioData) {
    if (!isLocalActive) return;

    if (audioData.length < 16000) {
        console.log('[LocalAI] Audio too short, skipping');
        if (pendingTranscriptParts.length > 0) {
            schedulePendingDispatch();
        } else if (!isAnyChannelSpeaking()) {
            sendToRenderer('update-status', 'Listening...');
        }
        return;
    }

    try {
        const transcription = await transcribeAudio(audioData);

        if (!transcription || transcription.length < 3) {
            console.log('[LocalAI] Empty or filler transcription, skipping');
            if (pendingTranscriptParts.length > 0) {
                schedulePendingDispatch();
            } else if (!isAnyChannelSpeaking()) {
                sendToRenderer('update-status', 'Listening...');
            }
            return;
        }

        pendingTranscriptParts.push(transcription.trim());
        schedulePendingDispatch();
    } catch (error) {
        console.error('[LocalAI] Transcription error:', error);
        if (pendingTranscriptParts.length > 0) {
            schedulePendingDispatch();
        } else {
            sendToRenderer('update-status', 'Listening...');
        }
    }
}

async function readStreamingResponse(response, onText) {
    const decoder = new TextDecoder();
    let pendingText = '';
    let fullText = '';

    for await (const chunk of response.body) {
        pendingText += decoder.decode(chunk, { stream: true });
        const lines = pendingText.split('\n');
        pendingText = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;

            const event = JSON.parse(data);
            const token = event.choices?.[0]?.delta?.content || '';
            if (!token) continue;

            fullText += token;
            onText(fullText);
        }
    }

    return fullText;
}

async function requestLlama(messages, onText) {
    if (!llamaBaseUrl) {
        throw new Error('Llama server is not running');
    }

    const response = await fetch(`${llamaBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'local',
            messages,
            stream: true,
            max_tokens: 2048,
            chat_template_kwargs: {
                enable_thinking: false,
            },
        }),
    });

    if (!response.ok || !response.body) {
        const errorText = await response.text();
        throw new Error(`Llama server returned HTTP ${response.status}: ${errorText}`);
    }

    return readStreamingResponse(response, onText);
}

async function sendToLlama(transcription) {
    if (hasGroqKey()) {
        console.log('[LocalAI] Routing transcription to Groq (5ms):', transcription);
        sendToRenderer('update-status', 'Generating response (Groq)...');
        return await sendToGroq(transcription);
    }
    localConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    if (localConversationHistory.length > 20) {
        localConversationHistory = localConversationHistory.slice(-20);
    }

    try {
        const messages = [{ role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' }, ...localConversationHistory];

        let isFirst = true;
        const fullText = await requestLlama(messages, text => {
            sendToRenderer(isFirst ? 'new-response' : 'update-response', text);
            isFirst = false;
        });

        if (fullText.trim()) {
            localConversationHistory.push({
                role: 'assistant',
                content: fullText.trim(),
            });
            saveConversationTurn(transcription, fullText);
        }

        console.log('[LocalAI] Llama response completed');
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('[LocalAI] Llama error:', error);
        sendToRenderer('update-status', 'Local AI error: ' + error.message);
        throw error;
    }
}

function formatDownloadStatus(label, progress) {
    if (!progress.expectedBytes) {
        return `Downloading ${label}...`;
    }

    const percentage = Math.floor((progress.downloadedBytes / progress.expectedBytes) * 100);
    return `Downloading ${label}... ${percentage}%`;
}

function sendDownloadProgress(label, progress = null) {
    const percentage = progress?.expectedBytes ? Math.min(100, Math.floor((progress.downloadedBytes / progress.expectedBytes) * 100)) : null;
    sendToRenderer('local-ai-download-progress', {
        active: true,
        label,
        percentage,
    });
}

function getDirectoryEntries(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        return new Set();
    }

    const entries = new Set();
    const visit = currentPath => {
        for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
            const entryPath = path.join(currentPath, entry.name);
            entries.add(entryPath);
            if (entry.isDirectory()) {
                visit(entryPath);
            }
        }
    };

    visit(directoryPath);
    return entries;
}

function removeNewLlamaCacheEntries() {
    const cacheDirectory = path.join(getModelsDirectory(), 'llama');
    const currentEntries = Array.from(getDirectoryEntries(cacheDirectory));
    currentEntries.sort((first, second) => second.length - first.length);

    for (const entryPath of currentEntries) {
        if (!llamaCacheSnapshot.has(entryPath)) {
            fs.rmSync(entryPath, { recursive: true, force: true });
        }
    }
}

async function prepareNativeFiles(llamaModelReference, whisperModel, signal) {
    const binaryProgress = label => progress => {
        sendToRenderer('update-status', formatDownloadStatus(label, progress));
        sendDownloadProgress(label, progress);
    };

    sendDownloadProgress('Checking Llama runner');
    const llamaBinaryPath = await ensureNativeBinary('llama', binaryProgress('Llama runner'), signal);

    sendDownloadProgress('Checking Whisper runner');
    const whisperBinaryPath = await ensureNativeBinary('whisper', binaryProgress('Whisper runner'), signal);

    let whisperModelPath;
    sendToRenderer('whisper-downloading', true);
    try {
        sendDownloadProgress('Checking Whisper model');
        whisperModelPath = await ensureWhisperModel(whisperModel, binaryProgress('Whisper model'), signal);
    } finally {
        sendToRenderer('whisper-downloading', false);
    }

    sendDownloadProgress('Checking language model');
    const llamaFiles = await ensureLlamaModel(llamaModelReference, binaryProgress('Language model'), binaryProgress('Vision model'), signal);
    return {
        llamaBinaryPath,
        whisperBinaryPath,
        whisperModelPath,
        llamaModelPath: llamaFiles.modelPath,
        projectorPath: llamaFiles.projectorPath,
    };
}

function validatePreparedNativeFiles(nativeFiles) {
    const requiredFiles = [
        ['Llama runner', nativeFiles.llamaBinaryPath],
        ['Whisper runner', nativeFiles.whisperBinaryPath],
        ['Whisper model', nativeFiles.whisperModelPath],
        ['Language model', nativeFiles.llamaModelPath],
        ['Vision model', nativeFiles.projectorPath],
    ];

    for (const [label, filePath] of requiredFiles) {
        if (!filePath || !fs.existsSync(filePath)) {
            throw new Error(`${label} path is invalid: ${filePath}`);
        }
    }
}

async function startWhisperServer(executablePath, modelPath) {
    const port = await getAvailablePort();
    whisperBaseUrl = `http://127.0.0.1:${port}`;
    whisperProcess = startNativeServer({
        executablePath,
        arguments: ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port)],
        name: 'Whisper',
    });

    await waitForServer(`${whisperBaseUrl}/`, whisperProcess, 120000);
}

async function startLlamaServer(executablePath, modelPath, projectorPath) {
    if (!modelPath || !fs.existsSync(modelPath)) {
        throw new Error(`Language model path is invalid: ${modelPath}`);
    }
    if (!projectorPath || !fs.existsSync(projectorPath)) {
        throw new Error(`Vision model path is invalid: ${projectorPath}`);
    }

    const port = await getAvailablePort();
    const argumentsList = [
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--alias',
        'local',
        '-c',
        '8192',
        '-m',
        modelPath,
        '--mmproj',
        projectorPath,
    ];

    if (process.platform === 'darwin') {
        argumentsList.push('-ngl', '99');
    }

    llamaBaseUrl = `http://127.0.0.1:${port}`;
    llamaProcess = startNativeServer({
        executablePath,
        arguments: argumentsList,
        name: 'Llama',
    });

    await waitForServer(`${llamaBaseUrl}/health`, llamaProcess, 30 * 60 * 1000);
}

async function initializeLocalSession(model, whisperModel, profile, customPrompt) {
    console.log('[LocalAI] Initializing native local session:', { model, whisperModel, profile });
    sendToRenderer('session-initializing', true);

    try {
        closeLocalSession();
        initializationController = new AbortController();
        llamaCacheSnapshot = getDirectoryEntries(path.join(getModelsDirectory(), 'llama'));
        currentSystemPrompt = getSystemPrompt(profile, customPrompt, false);
        llamaModel = model;

        const binaryProgress = label => progress => {
            sendToRenderer('update-status', formatDownloadStatus(label, progress));
            sendDownloadProgress(label, progress);
        };
        const useGroq = hasGroqKey();
        if (useGroq) {
            resetAllChannelStates();
            localConversationHistory = [];

            initializeNewSession(profile, customPrompt);
            isLocalActive = true;
            initializationController = null;
            sendToRenderer('local-ai-download-progress', { active: false });
            sendToRenderer('session-initializing', false);
            sendToRenderer('update-status', 'Listening (Groq Turbo: Whisper + LLM)...');
            console.log('[LocalAI] Groq Turbo (Cloud Whisper + Groq LLM) session initialized instantly');
            return true;
        }

        const nativeFiles = await prepareNativeFiles(model, whisperModel, initializationController.signal);
        validatePreparedNativeFiles(nativeFiles);

        sendToRenderer('update-status', 'Starting Whisper...');
        sendDownloadProgress('Starting Whisper');
        await startWhisperServer(nativeFiles.whisperBinaryPath, nativeFiles.whisperModelPath);

        sendToRenderer('update-status', 'Loading local language model...');
        sendDownloadProgress('Loading language model');
        await startLlamaServer(nativeFiles.llamaBinaryPath, nativeFiles.llamaModelPath, nativeFiles.projectorPath);

        resetAllChannelStates();
        localConversationHistory = [];

        initializeNewSession(profile, customPrompt);
        isLocalActive = true;
        initializationController = null;
        sendToRenderer('local-ai-download-progress', { active: false });
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'Local AI ready - Listening...');
        console.log('[LocalAI] Native session initialized successfully');
        return true;
    } catch (error) {
        const wasCancelled = error.name === 'AbortError' || initializationController?.signal.aborted;
        if (wasCancelled) {
            console.log('[LocalAI] Initialization cancelled');
        } else {
            console.error('[LocalAI] Initialization error:', error);
        }
        closeLocalSession();
        if (wasCancelled) {
            removeNewLlamaCacheEntries();
        }
        sendToRenderer('local-ai-download-progress', { active: false });
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', wasCancelled ? 'Local AI download cancelled' : 'Local AI error: ' + error.message);
        return false;
    }
}

function processLocalAudio(monoChunk24k, channel = 'speaker') {
    if (!isLocalActive) return;
    const state = channelStates[channel] || channelStates.speaker;

    const pcm16k = resample24kTo16k(monoChunk24k, state);
    if (pcm16k.length > 0) {
        processVad(pcm16k, channel);
    }
}

function closeLocalSession() {
    isLocalActive = false;
    initializationController?.abort();
    initializationController = null;
    stopNativeServer(llamaProcess);
    stopNativeServer(whisperProcess);
    llamaProcess = null;
    whisperProcess = null;
    llamaBaseUrl = null;
    whisperBaseUrl = null;
    llamaModel = null;
    resetAllChannelStates();
    localConversationHistory = [];
    currentSystemPrompt = null;
}

async function cancelLocalInitialization() {
    if (!initializationController) {
        return false;
    }

    initializationController.abort();
    stopNativeServer(llamaProcess);
    stopNativeServer(whisperProcess);
    await new Promise(resolve => setTimeout(resolve, 300));
    removeNewLlamaCacheEntries();
    sendToRenderer('local-ai-download-progress', { active: false });
    sendToRenderer('session-initializing', false);
    return true;
}

function isLocalSessionActive() {
    return isLocalActive;
}

async function sendLocalText(text) {
    if (!isLocalActive) {
        return { success: false, error: 'No active local session' };
    }
    if (hasGroqKey()) {
        console.log('[LocalAI] Routing text to Groq:', text);
        await sendToGroq(text);
        return { success: true };
    }
    if (!llamaProcess) {
        return { success: false, error: 'No active local session' };
    }

    try {
        await sendToLlama(text);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function sendLocalImage(base64Data, prompt) {
    if (!isLocalActive) {
        return { success: false, error: 'No active local session' };
    }
    if (hasGroqKey()) {
        console.log('[LocalAI] Routing image to Groq vision');
        return await sendImageToGroq(base64Data, prompt);
    }
    if (!llamaProcess) {
        return { success: false, error: 'No active local session' };
    }

    const userMessage = {
        role: 'user',
        content: [
            { type: 'text', text: prompt },
            {
                type: 'image_url',
                image_url: {
                    url: `data:image/jpeg;base64,${base64Data}`,
                },
            },
        ],
    };

    localConversationHistory.push({ role: 'user', content: prompt });
    if (localConversationHistory.length > 20) {
        localConversationHistory = localConversationHistory.slice(-20);
    }

    try {
        sendToRenderer('update-status', 'Analyzing image...');
        const messages = [
            { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
            ...localConversationHistory.slice(0, -1),
            userMessage,
        ];

        let isFirst = true;
        const fullText = await requestLlama(messages, text => {
            sendToRenderer(isFirst ? 'new-response' : 'update-response', text);
            isFirst = false;
        });

        if (fullText.trim()) {
            localConversationHistory.push({ role: 'assistant', content: fullText.trim() });
            saveConversationTurn(prompt, fullText);
        }

        sendToRenderer('update-status', 'Listening...');
        return { success: true, text: fullText, model: llamaModel };
    } catch (error) {
        console.error('[LocalAI] Image error:', error);
        sendToRenderer('update-status', 'Local AI image error: ' + error.message);
        return { success: false, error: error.message };
    }
}

module.exports = {
    initializeLocalSession,
    cancelLocalInitialization,
    processLocalAudio,
    closeLocalSession,
    isLocalSessionActive,
    sendLocalText,
    sendLocalImage,
};
