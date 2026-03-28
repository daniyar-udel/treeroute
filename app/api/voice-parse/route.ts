import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";

interface VoiceParseResult {
  origin: string;
  destination: string;
}

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON found");
  return text.slice(start, end + 1);
}

export async function POST(request: NextRequest) {
  const { transcript } = (await request.json()) as { transcript?: string };

  if (!transcript || transcript.trim().length < 3) {
    return NextResponse.json({ error: "Empty transcript" }, { status: 400 });
  }

  const apiKey = process.env.GOOGLE_AI_API_KEY ?? "";

  if (!apiKey) {
    return NextResponse.json({ error: "Gemini API key not configured" }, { status: 500 });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
      config: {
        systemInstruction:
          'You extract walking origin and destination from voice commands. Always respond with a single valid JSON object only — no markdown, no code fences, no extra text. The JSON must have exactly two string fields: "origin" and "destination". Both must be NYC location names. If only one location is mentioned, use empty string for origin. If no locations found, return {"origin":"","destination":""}.',
      },
      contents: [{ role: "user", parts: [{ text: `Extract origin and destination from this voice command: "${transcript}"` }] }],
    });

    const text = response.text ?? "";
    const parsed = JSON.parse(extractJson(text)) as VoiceParseResult;

    return NextResponse.json({
      origin: parsed.origin?.trim() ?? "",
      destination: parsed.destination?.trim() ?? "",
    });
  } catch {
    return NextResponse.json({ error: "Failed to parse voice command" }, { status: 500 });
  }
}
