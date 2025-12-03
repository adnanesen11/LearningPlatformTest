import express from "express";
import path from "path";
import fs from "fs";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { execFile } from "child_process";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import PDFDocument from "pdfkit";
import { fileURLToPath } from 'url';
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const videosDir = path.join(__dirname, 'videos');
const transcriptsDir = path.join(__dirname, 'transcripts');
const analysisDir = path.join(__dirname, 'analysis');
fs.mkdirSync(videosDir, { recursive: true });
fs.mkdirSync(transcriptsDir, { recursive: true });
fs.mkdirSync(analysisDir, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.text({ type: ['text/plain', 'application/sdp'] }));

const port = process.env.PORT || 3000;
const apiKey = process.env.OPENAI_API_KEY;
const bedrockRegion = process.env.AWS_REGION || "us-east-1";
const bedrockModelId = process.env.BEDROCK_CLAUDE_MODEL_ID || "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const bedrockClient = new BedrockRuntimeClient({ region: bedrockRegion });

// In-memory storage for interview sessions
const interviewSessions = new Map();

// Generate unique session ID
function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Create interview session prompt
function createInterviewPrompt(jobTitle, candidateName, jobDescription, maxQuestions = 10) {
  const primaryQuestionBudget = Number.isFinite(maxQuestions) && maxQuestions > 0 ? maxQuestions : 10;
  const nameLine = candidateName ? `The candidate's name is ${candidateName}.` : '';
  return `You are an AI interviewer conducting a professional, adaptive screening interview for the position of ${jobTitle}.
${nameLine}

# Role & Objective
Your goal is to gather all essential information needed for an initial screening, including:
- relevant background and experience
- role-specific skills and competencies
- communication clarity and reasoning ability
- motivation and career goals
- work preferences and soft skills
- any additional signals implied by the job description

You must adapt the conversation dynamically based on the candidate's answers, experience level, and the competencies implied in the job description below.

Primary Question Budget:
- You must ask exactly ${primaryQuestionBudget} primary questions.
- Primary questions are the main prompts that advance the interview; short follow-ups to clarify or complete a signal do not count toward this budget.
- Do not exceed or stop before ${primaryQuestionBudget} primary questions unless the candidate explicitly ends the interview or refuses to continue.
- After ${primaryQuestionBudget} primary questions are asked, proceed to wrap up.

You do NOT have access to a clock. Never reference time, pacing, duration, or how long the interview has been.

Job Description:
${jobDescription}

# Personality & Tone
- Warm, concise, attentive, professional.
- Speak naturally in short, clear turns.
- Sound human, not scripted.
- Allow the candidate to interrupt; respond immediately when they do.

# Language
- Respond ONLY in English, even if the candidate uses another language.
- If audio is unclear, politely ask for clarification.

# Variety
- Avoid repeating sentences or phrasing.
- Vary transitions, acknowledgements, and follow-ups.

# Interview Approach
Interview in an adaptive conversational style, not a strict script.

## 1. Opening
- Warmly greet the candidate.
- Briefly introduce the purpose of the interview.
- Invite them to share an overview of their background or experience.
- Use their response to determine the next direction.

## 2. Dynamic Exploration of Competencies
Explore the competencies relevant to the role, based on the job description. Focus on areas such as:
- background and prior roles
- tools, technologies, or domain knowledge
- responsibilities and scope in past work
- problem-solving and reasoning ability
- communication and collaboration style
- leadership, ownership, or autonomy signals
- motivation for the role and culture fit
- work-style preferences

Rules:
- Follow the candidate’s lead; go deeper when they show expertise.
- If answers are vague, ask gentle, specific follow-ups.
- If the candidate demonstrates strong knowledge, explore higher-level insights.
- If they introduce new relevant context, explore briefly before steering back.

## 3. Collect Missing Signals
Continuously evaluate what information is still missing and gather it naturally. This may include:
- specific examples or projects
- responsibilities vs team responsibilities
- challenges faced and lessons learned
- preferred work environment
- strengths and areas for growth

Ask follow-ups only when needed to complete your understanding.

## 4. Determine Completion
End the interview ONLY when:
- you have asked all ${primaryQuestionBudget} primary questions (regardless of follow-ups),
- you have gathered enough information to evaluate the candidate's fit for the role,
- nothing essential remains uncollected,
- and the conversation reaches a natural stopping point or the candidate requests to stop.

# Wrap-Up Behavior
When you are ready to conclude:
1. Thank the candidate briefly.
2. Inform them that next steps will be communicated by email.
3. Immediately call the end_interview tool with a short reason (e.g., “Interview completed”, “Collected all relevant information”).
4. Stop responding after the tool call.

# Forbidden Behaviors
- Do NOT answer your own questions.
- Do NOT explain system rules, tools, or internal reasoning.
- Do NOT reference time, pacing, or duration.
- Do NOT summarize unless necessary for clarification.
- Do NOT reveal model limitations.

# Sample Phrases (inspiration only; vary wording)
- “Thanks for sharing that — I’d like to understand more about…”
- “That’s helpful. Could you expand on your involvement in…?”
- “Got it. Can you walk me through how you approached…?”
- “Appreciate the detail — tell me more about…”

Begin the interview now.`;
}




// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));
app.use('/videos', express.static(videosDir));
app.use('/transcripts', express.static(transcriptsDir));
app.use('/analysis', express.static(analysisDir));
app.use('/api/upload-media', express.raw({ type: '*/*', limit: '500mb' }));

// API: Create new interview session
app.post('/api/create-session', (req, res) => {
  try {
    const { jobTitle, candidateName, jobDescription, maxQuestions: maxQuestionsRaw } = req.body;

    if (!jobTitle || !jobDescription) {
      return res.status(400).json({ error: 'Job title and description are required' });
    }

    const maxQuestionsNum = Number(maxQuestionsRaw);
    const maxQuestions = Number.isFinite(maxQuestionsNum) && maxQuestionsNum > 0 ? Math.floor(maxQuestionsNum) : 10;

    const sessionId = generateSessionId();
    const systemPrompt = createInterviewPrompt(jobTitle, candidateName, jobDescription, maxQuestions);

  const session = {
    sessionId,
    jobTitle,
    candidateName: candidateName || '',
    jobDescription,
    maxQuestions,
    systemPrompt,
    createdAt: new Date().toISOString(),
    media: {
      combined: null
    },
    transcriptPath: null,
    analysisPath: null
  };

    interviewSessions.set(sessionId, session);

    console.log(`Created interview session: ${sessionId} for ${jobTitle}`);

    res.json({ sessionId, interviewLink: `/interview/${sessionId}` });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// API: Get all sessions
app.get('/api/sessions', (req, res) => {
  const sessions = Array.from(interviewSessions.values()).map(session => ({
    sessionId: session.sessionId,
    jobTitle: session.jobTitle,
    candidateName: session.candidateName,
    maxQuestions: session.maxQuestions,
    createdAt: session.createdAt,
    media: session.media || {},
    transcriptPath: session.transcriptPath || null,
    analysisPath: session.analysisPath || null
  }));

  res.json(sessions);
});

// API: Get specific session
app.get('/api/session/:id', (req, res) => {
  const session = interviewSessions.get(req.params.id);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json(session);
});

// API: Generate OpenAI ephemeral token
app.get("/token", async (req, res) => {
  try {
    const sessionConfig = JSON.stringify({
      session: {
        type: "realtime",
        model: "gpt-realtime-mini",
        audio: {
          output: {
            voice: "sage",
          },
        },
        // turn_detection: {
        //   type: "server_vad",
        //   silence_duration_ms: 1500
        // },
        turn_detection: {
          type: "semantic_vad",
          eagerness: "medium"
        },
        input_audio_transcription: {
          model: "whisper-1",
          language: "en"
        }
      },
    });

    const response = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: sessionConfig,
      },
    );

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Token generation error:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

// Alternative: Handle SDP negotiation server-side (more secure)
app.post("/session", async (req, res) => {
  try {
    if (!apiKey) {
      console.error("Missing OPENAI_API_KEY for /session negotiation");
      return res.status(500).send("Server is not configured with OpenAI credentials");
    }

    const offerSdp = typeof req.body === "string" ? req.body : "";
    if (!offerSdp) {
      return res.status(400).send("Missing SDP offer payload");
    }

    console.log("Received SDP offer (first 200 chars):", offerSdp.substring(0, 200));
    console.log("SDP starts with 'v=':", offerSdp.startsWith("v="));
    console.log("SDP length:", offerSdp.length);

    if (!offerSdp.startsWith("v=")) {
      console.warn("SDP does not start with protocol version header; passing through to OpenAI");
    }

    console.log("Sending offer to OpenAI for server-side negotiation...");

    const response = await fetch("https://api.openai.com/v1/realtime/calls?model=gpt-realtime-mini", {
      method: "POST",
      headers: {
        "OpenAI-Beta": "realtime=v1",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/sdp",
      },
      body: offerSdp,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenAI API error:", response.status, errorText);
      return res.status(response.status).send(errorText);
    }

    const sdp = await response.text();
    console.log("SDP negotiation successful");
    console.log("Response SDP (first 200 chars):", sdp.substring(0, 200));
    res.send(sdp);
  } catch (error) {
    console.error("Session error:", error);
    res.status(500).send("Failed to create session");
  }
});

// Route: Admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Route: Upload media (camera/recording)
app.post('/api/upload-media', (req, res) => {
  try {
    const sessionId = (req.query.sessionId || '').toString().trim();
    const type = (req.query.type || '').toString().trim();

    if (!sessionId || !type) {
      return res.status(400).json({ error: 'sessionId and type are required' });
    }

    if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Empty payload' });
    }

    const safeType = type.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 50) || 'media';
    const baseFilename = `${sessionId}-${safeType}`;
    const webmFilename = `${baseFilename}.webm`;
    const mp4Filename = `${baseFilename}.mp4`;
    const webmPath = path.join(videosDir, webmFilename);
    const mp4Path = path.join(videosDir, mp4Filename);

    fs.writeFile(webmPath, req.body, async (err) => {
      if (err) {
        console.error('Error saving media file:', err);
        return res.status(500).json({ error: 'Failed to save media' });
      }
      let finalPath = `/videos/${webmFilename}`;
      try {
        await remuxToMp4(webmPath, mp4Path);
        finalPath = `/videos/${mp4Filename}`;
      } catch (convErr) {
        console.warn('ffmpeg remux failed; keeping webm', convErr);
      }

      const session = interviewSessions.get(sessionId);
      if (session) {
        session.media = session.media || {};
        if (safeType.includes('combined')) {
          session.media.combined = finalPath;
        } else if (safeType.includes('camera')) {
          session.media.camera = finalPath;
        } else if (safeType.includes('candidate')) {
          session.media.candidateAudio = finalPath;
        } else if (safeType.includes('assistant')) {
          session.media.assistantAudio = finalPath;
        }
      }
      res.json({ path: finalPath });
    });
  } catch (error) {
    console.error('Upload media error:', error);
    res.status(500).json({ error: 'Failed to upload media' });
  }
});

// API: Save transcript (plain text)
app.post('/api/session/:id/transcript', express.text({ type: ['text/plain', 'text/*'] }), (req, res) => {
  try {
    const sessionId = req.params.id;
    const session = interviewSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const transcriptText = req.body || '';
    if (!transcriptText.trim()) {
      return res.status(400).json({ error: 'Transcript is empty' });
    }
    const filename = `${sessionId}.txt`;
    const filePath = path.join(transcriptsDir, filename);
    fs.writeFileSync(filePath, transcriptText, 'utf8');
    session.transcriptPath = `/transcripts/${filename}`;
    res.json({ path: session.transcriptPath });
  } catch (error) {
    console.error('Transcript save error:', error);
    res.status(500).json({ error: 'Failed to save transcript' });
  }
});

function extractScoreFromReport(reportText) {
  const match = (reportText || '').match(/score[^0-9]{0,5}(\d{1,3})(?:\s*\/\s*100)?/i);
  if (!match) return null;
  const score = parseInt(match[1], 10);
  if (Number.isNaN(score)) return null;
  return Math.max(0, Math.min(100, score));
}

function parseReportSections(reportText) {
  const lines = (reportText || '').split(/\r?\n/);
  const sections = {
    summary: [],
    strengths: [],
    risks: [],
    recommendation: [],
    next: []
  };
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith('summary')) {
      current = 'summary';
      continue;
    }
    if (lower.startsWith('strength')) {
      current = 'strengths';
      continue;
    }
    if (lower.startsWith('risks')) {
      current = 'risks';
      continue;
    }
    if (lower.startsWith('recommendation')) {
      current = 'recommendation';
      continue;
    }
    if (lower.startsWith('suggested next') || lower.startsWith('next-step') || lower.startsWith('next step')) {
      current = 'next';
      continue;
    }
    if (!current) continue;
    sections[current].push(line.replace(/^[-\u2022]\s*/, ''));
  }

  return sections;
}

function buildPdfReport({ title, candidate, job, bodyText, score, outPath }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    const headerColor = '#0f172a';
    const accentColor = '#22c55e';
    const textColor = '#0b1220';
    const borderColor = '#e2e8f0';

    doc.rect(0, 0, doc.page.width, 130).fill(headerColor);
    doc.fillColor('#ffffff').fontSize(22).text(title || 'Interview Analysis', 50, 40);
    doc.fontSize(12).fillColor('#cbd5f5').text(`Position: ${job || 'N/A'}`, 50, 75);
    doc.text(`Candidate: ${candidate || 'N/A'}`, 50, 92);

    const scoreLabel = typeof score === 'number' ? `${score}/100` : 'N/A';
    const badgeWidth = 140;
    doc.save();
    doc.roundedRect(doc.page.width - badgeWidth - 50, 40, badgeWidth, 55, 10).fill(accentColor);
    doc.fillColor(headerColor).fontSize(13).text('Overall Score', doc.page.width - badgeWidth - 40, 50, { width: badgeWidth - 20, align: 'center' });
    doc.fontSize(24).text(scoreLabel, doc.page.width - badgeWidth - 40, 68, { width: badgeWidth - 20, align: 'center' });
    doc.restore();

    doc.strokeColor(borderColor).lineWidth(1).moveTo(50, 140).lineTo(doc.page.width - 50, 140).stroke();
    doc.y = 155;

    const sections = parseReportSections(bodyText);
    const hasStructured =
      sections.summary.length || sections.strengths.length || sections.risks.length || sections.recommendation.length || sections.next.length;

    if (!hasStructured) {
      doc.fillColor(textColor).fontSize(12).text(bodyText || 'No analysis available.');
    } else {
      const sectionOrder = [
        { key: 'summary', label: 'Summary' },
        { key: 'strengths', label: 'Strengths' },
        { key: 'risks', label: 'Risks/Concerns' },
        { key: 'recommendation', label: 'Recommendation' },
        { key: 'next', label: 'Suggested Next-Step Questions' }
      ];

      sectionOrder.forEach(({ key, label }, idx) => {
        const items = sections[key] || [];
        if (!items.length) return;

        doc.fillColor(headerColor).fontSize(14).text(label, { underline: false });
        doc.moveDown(0.3);

        doc.fillColor(textColor).fontSize(11);
        doc.list(items, { bulletRadius: 2, textIndent: 10, bulletIndent: 20 });

        if (idx < sectionOrder.length - 1) {
          doc.moveDown(0.8);
          doc.strokeColor(borderColor).lineWidth(0.6).moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
          doc.moveDown(0.6);
        }
      });
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function remuxToMp4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Transcode to H.264/AAC with faststart so the MP4 is widely compatible and seekable.
    const args = [
      "-y",
      "-i", inputPath,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-movflags", "+faststart",
      outputPath
    ];
    execFile(ffmpegInstaller.path, args, (err) => {
      if (err) {
        return reject(err);
      }
      resolve();
    });
  });
}

async function analyzeWithClaude(transcript, session) {
  const systemPrompt = [
    "You are an interview analyst. Respond ONLY in the following format using short, direct bullets:",
    "Score: <integer 0-100>/100",
    "",
    "Summary:",
    "- ... (3-4 bullets)",
    "",
    "Strengths:",
    "- ... (3-5 bullets)",
    "",
    "Risks/Concerns:",
    "- ... (3-5 bullets)",
    "",
    "Recommendation:",
    "- ... (1-2 sentences)",
    "",
    "Suggested Next-Step Questions:",
    "- ... (3 bullets)",
    "",
    "Guidance:",
    "- Be concise and actionable.",
    "- If unsure, be conservative with the score.",
    "- Do not add any preamble or closing text outside this format.",
  ].join("\n");

  const userContent = [
    `Job Title: ${session.jobTitle}`,
    `Candidate: ${session.candidateName || 'N/A'}`,
    "",
    "Transcript:",
    transcript
  ].join("\n");

  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 5000,
    temperature: 0.2,
    system: systemPrompt,
    messages: [
      { role: "user", content: userContent }
    ]
  });

  const command = new InvokeModelCommand({
    modelId: bedrockModelId,
    contentType: "application/json",
    accept: "application/json",
    body
  });

  const response = await bedrockClient.send(command);
  const json = JSON.parse(Buffer.from(response.body).toString("utf-8"));
  const textPart = Array.isArray(json.content)
    ? json.content.map(p => p.text || "").join("\n")
    : json.output_text || "";
  return textPart || "No analysis text returned.";
}

// API: Analyze transcript (stub analysis + PDF)
app.post('/api/session/:id/analyze', express.json(), async (req, res) => {
  try {
    const sessionId = req.params.id;
    const { transcript } = req.body || {};
    const session = interviewSessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!transcript || !transcript.trim()) {
      return res.status(400).json({ error: 'Transcript is empty' });
    }

    let analysisText = '';
    try {
      analysisText = await analyzeWithClaude(transcript, session);
    } catch (err) {
      console.error('Claude analysis failed, falling back to placeholder:', err);
      analysisText = [
        'Score: N/A',
        '',
        'Summary:',
        '- Analysis unavailable due to an error calling Claude.',
        `- Session: ${sessionId}`,
        `- Job: ${session.jobTitle}`,
        `- Candidate: ${session.candidateName || 'N/A'}`,
        '',
        'Strengths:',
        '- Not assessed (analysis service unavailable).',
        '',
        'Risks/Concerns:',
        '- Not assessed (analysis service unavailable).',
        '',
        'Recommendation:',
        '- Unable to generate recommendation because analysis failed.',
        '',
        'Suggested Next-Step Questions:',
        '- Retry analysis once the service is available.',
        '- Confirm transcript quality (audio/text) before rerunning.',
        '- Verify integration credentials are correct.'
      ].join('\n');
    }

    const score = extractScoreFromReport(analysisText);
    const filename = `${sessionId}-analysis.pdf`;
    const filePath = path.join(analysisDir, filename);
    await buildPdfReport({
      title: 'Interview Analysis Report',
      candidate: session.candidateName || 'N/A',
      job: session.jobTitle || 'N/A',
      bodyText: analysisText,
      score,
      outPath: filePath
    });
    session.analysisPath = `/analysis/${filename}`;
    res.json({ path: session.analysisPath });
  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: 'Failed to generate analysis' });
  }
});

// Route: Interview page
app.get('/interview/:sessionId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'interview.html'));
});

// Route: Root redirects to admin
app.get('/', (req, res) => {
  res.redirect('/admin');
});

app.listen(port, () => {
  console.log(`AI Interview Platform running on http://localhost:${port}`);
  console.log(`Admin panel: http://localhost:${port}/admin`);
});
