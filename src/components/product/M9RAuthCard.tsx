"use client";

import Link from "next/link";
import AuthForm from "@/components/product/AuthForm";
import s from "./M9RAuthCard.module.css";

type Notice = { tone: "error" | "success"; text: string };

export default function M9RAuthCard({
  configured,
  next = "/dashboard",
  initialMode = "login",
  initialNotice = null,
}: {
  configured: boolean;
  next?: string;
  initialMode?: "login" | "signup";
  initialNotice?: Notice | null;
}) {
  return (
    <main className={s.page}>
      <div className={s.scanlines} aria-hidden="true" />
      <div className={s.grid} aria-hidden="true" />
      <Link className={s.homeLink} href="/" aria-label="Back to M9R home">
        ← BACK TO M9R
      </Link>

      <section className={s.card} aria-labelledby="m9r-auth-title">
        <div className={s.cardBar}>
          <span className={s.windowDots} aria-hidden="true"><i /><i /><i /></span>
          <span>M9R // AUTH CHANNEL</span>
          <span className={s.cardStatus}>● ONLINE</span>
        </div>

        <div className={s.cardInner}>
          <div className={s.identity}>
            <span className={s.wordmark}>M9R</span>
            <span className={s.signal}>SECURE ACCESS / 01</span>
          </div>
          <h1 id="m9r-auth-title" className={s.srOnly}>M9R account access</h1>
          <div className={s.form}>
            <AuthForm
              configured={configured}
              next={next}
              initialNotice={initialNotice}
              initialMode={initialMode}
            />
          </div>
        </div>

        <div className={s.cardFooter}>
          <span>ENCRYPTED WORKSPACE GATEWAY</span>
          <span>M9R / THE AIR BETWEEN AGENTS</span>
        </div>
      </section>
    </main>
  );
}
