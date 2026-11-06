"use client";
import { useState } from "react";
import { Icon } from "./icons";

export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed"); // no clipboard permission: the code stays selectable
    }
    setTimeout(() => setState("idle"), 1800);
  };
  return (
    <>
      <button type="button" className="copy" onClick={copy} aria-label="Copy code to the clipboard">
        <Icon name={state === "copied" ? "check" : "copy"} size={14} /> {state === "copied" ? "Copied" : state === "failed" ? "Select and copy" : "Copy"}
      </button>
      <span className="sr-only" role="status">{state === "copied" ? "Copied to the clipboard" : ""}</span>
    </>
  );
}
