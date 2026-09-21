"use client";

import Link from "next/link";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import AuthForm from "@/components/product/AuthForm";
import s from "./M9RAuthTerminal.module.css";

type AuthMode = "login" | "signup";
type Notice = { tone: "error" | "success"; text: string };

export type M9RAuthTerminalHandle = {
  focusTerminal: (mode?: AuthMode) => void;
  openAuth: (mode?: AuthMode) => void;
};

type Props = {
  configured: boolean;
  next?: string;
  initialMode?: AuthMode;
  initialNotice?: Notice | null;
  compact?: boolean;
  showTerminal?: boolean;
  autoOpen?: boolean;
};

const modeLabel = (mode: AuthMode) => (mode === "signup" ? "GET STARTED" : "LOGIN");

const M9RAuthTerminal = forwardRef<M9RAuthTerminalHandle, Props>(function M9RAuthTerminal(
  {
    configured,
    next = "/dashboard",
    initialMode = "login",
    initialNotice = null,
    compact = false,
    showTerminal = true,
    autoOpen = false,
  },
  ref,
) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<AuthMode>(initialMode);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const showAuthDialog = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const openAuth = useCallback((mode = selected) => {
    setSelected(mode);
    requestAnimationFrame(showAuthDialog);
  }, [selected, showAuthDialog]);

  const focusTerminal = useCallback((mode = selected) => {
    setSelected(mode);
    requestAnimationFrame(() => {
      terminalRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      screenRef.current?.focus();
    });
  }, [selected]);

  useImperativeHandle(ref, () => ({ focusTerminal, openAuth }), [focusTerminal, openAuth]);

  useEffect(() => {
    if (autoOpen && mounted) requestAnimationFrame(showAuthDialog);
  }, [autoOpen, mounted, showAuthDialog]);

  function onScreenKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((current) => (current === "signup" ? "login" : "signup"));
    }
    if (event.key === "Enter") {
      event.preventDefault();
      openAuth();
    }
  }

  const authDialog = (
    <dialog
      ref={dialogRef}
      className={s.authDialog}
      aria-label={`${modeLabel(selected)} M9R account`}
      onClick={(event) => { if (event.target === event.currentTarget) dialogRef.current?.close(); }}
    >
      <div className={s.authFrame}>
        <div className={s.authFrameBar}>
          <span><b aria-hidden="true">M9R</b> AUTH://{selected.toUpperCase()}</span>
          <button type="button" onClick={() => dialogRef.current?.close()} aria-label="Close authentication window">×</button>
        </div>
        <div className={s.authBody}>
          <AuthForm configured={configured} next={next} initialNotice={initialNotice} initialMode={selected} />
        </div>
      </div>
    </dialog>
  );

  return (
    <div className={`${s.surface} ${compact ? s.compactSurface : s.routeSurface}`}>
      {!compact && (
          <Link className={s.homeLink} href="/" aria-label="Back to M9R home">
            <span aria-hidden="true">←</span> ESC / BACK TO HOME
          </Link>
      )}

      {showTerminal && (
        <div ref={terminalRef} className={`${s.terminal} ${compact ? s.compactTerminal : s.routeTerminal}`}>
          <div className={s.terminalTopbar}>
            <span className={s.terminalLights} aria-hidden="true"><i /><i /><i /></span>
            <span>M9R_TERMINAL.EXE</span>
            <span className={s.terminalStatus}>● ONLINE</span>
          </div>
          <div
            ref={screenRef}
            className={s.terminalScreen}
            tabIndex={0}
            onKeyDown={onScreenKeyDown}
            aria-label="M9R authentication terminal"
          >
            <div className={s.bootLine}>M9R SYSTEM / SECURE CONNECTION ESTABLISHED</div>
            <div className={s.welcome}>WELCOME TO M9R<span className={s.cursor} aria-hidden="true">_</span></div>
            <p className={s.prompt}>Choose your entry point:</p>
            <div className={s.options} role="group" aria-label="M9R account actions">
              {(["signup", "login"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`${s.option} ${selected === mode ? s.optionSelected : ""}`}
                  aria-pressed={selected === mode}
                  onClick={() => setSelected(mode)}
                >
                  <span aria-hidden="true">{selected === mode ? "▶" : "　"}</span>{modeLabel(mode)}
                </button>
              ))}
            </div>
            <div className={s.enterRow}>
              <button type="button" className={s.enterKey} onClick={() => openAuth()}>
                <span>↵</span> ENTER
              </button>
              <span className={s.enterHint}>↑↓ SELECT&nbsp;&nbsp; ENTER OPEN</span>
            </div>
            <div className={s.terminalFooter}>M9R // THE AIR BETWEEN AGENTS // v0.1</div>
          </div>
        </div>
      )}

      {mounted && typeof document !== "undefined" ? createPortal(authDialog, document.body) : authDialog}
    </div>
  );
});

export default M9RAuthTerminal;
