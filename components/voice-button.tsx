"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type VoiceState = "idle" | "listening" | "processing" | "error";

// Browser Speech Recognition types not in default TS lib
interface ISpeechRecognition extends EventTarget {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: ISpeechRecognitionEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface ISpeechRecognitionEvent {
  results: { length: number; [index: number]: { [index: number]: { transcript: string } } };
}

declare const SpeechRecognition: new () => ISpeechRecognition;

interface VoiceButtonProps {
  onResult: (origin: string, destination: string) => void;
  disabled?: boolean;
}

export function VoiceButton({ onResult, disabled }: VoiceButtonProps) {
  const [state, setState] = useState<VoiceState>("idle");
  const [transcript, setTranscript] = useState("");
  const transcriptRef = useRef("");
  const recognitionRef = useRef<ISpeechRecognition | null>(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
    };
  }, []);

  const start = useCallback(() => {
    const SR =
      (window as unknown as Record<string, unknown>)["SpeechRecognition"] as typeof SpeechRecognition | undefined ??
      (window as unknown as Record<string, unknown>)["webkitSpeechRecognition"] as typeof SpeechRecognition | undefined;

    if (!SR) {
      setState("error");
      setTimeout(() => setState("idle"), 2500);
      return;
    }

    transcriptRef.current = "";
    setTranscript("");

    const recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognitionRef.current = recognition;

    recognition.onstart = () => setState("listening");

    recognition.onresult = (event: ISpeechRecognitionEvent) => {
      let full = "";
      for (let i = 0; i < event.results.length; i++) {
        full += event.results[i][0].transcript;
      }
      transcriptRef.current = full.trim();
      setTranscript(full.trim());
    };

    recognition.onerror = () => {
      setState("error");
      setTimeout(() => setState("idle"), 2000);
    };

    recognition.onend = async () => {
      const text = transcriptRef.current.trim();

      if (!text) {
        setState("idle");
        return;
      }

      setState("processing");

      try {
        const res = await fetch("/api/voice-parse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript: text }),
        });

        const data = (await res.json()) as { origin?: string; destination?: string; error?: string };

        if (!data.error && (data.origin || data.destination)) {
          onResultRef.current(data.origin ?? "", data.destination ?? "");
          setState("idle");
        } else {
          setState("error");
          setTimeout(() => setState("idle"), 2500);
        }
      } catch {
        setState("error");
        setTimeout(() => setState("idle"), 2500);
      } finally {
        setTranscript("");
        transcriptRef.current = "";
      }
    };

    recognition.start();
  }, []);

  const handleClick = () => {
    if (state === "listening") {
      recognitionRef.current?.stop();
    } else if (state === "idle") {
      start();
    }
  };

  const label =
    state === "listening"
      ? "Tap to stop"
      : state === "processing"
        ? "Parsing route..."
        : state === "error"
          ? "Couldn't parse — try again"
          : "Speak your route";

  return (
    <div className="voice-button-wrap">
      <button
        aria-label={label}
        className={`voice-button voice-button-${state}`}
        disabled={disabled || state === "processing" || state === "error"}
        onClick={handleClick}
        type="button"
      >
        <MicIcon state={state} />
        <span>{label}</span>
      </button>

      {state === "listening" && transcript && (
        <p className="voice-transcript">&ldquo;{transcript}&rdquo;</p>
      )}
    </div>
  );
}

function MicIcon({ state }: { state: VoiceState }) {
  if (state === "processing") {
    return (
      <svg aria-hidden fill="none" height="20" viewBox="0 0 24 24" width="20">
        <circle cx="12" cy="12" opacity="0.3" r="10" stroke="currentColor" strokeWidth="2" />
        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeLinecap="round" strokeWidth="2">
          <animateTransform attributeName="transform" dur="0.8s" from="0 12 12" repeatCount="indefinite" to="360 12 12" type="rotate" />
        </path>
      </svg>
    );
  }

  return (
    <svg aria-hidden fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="20">
      {state === "listening" ? (
        <rect fill="currentColor" height="14" rx="3" stroke="none" width="10" x="7" y="5" />
      ) : (
        <rect height="14" rx="3" width="10" x="7" y="1" />
      )}
      <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="23" />
      <line x1="8" x2="16" y1="23" y2="23" />
    </svg>
  );
}
