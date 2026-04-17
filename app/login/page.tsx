"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const nextPath = params.get("next") || "/";
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "登录失败");
      router.push(nextPath);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "登录失败");
      setLoading(false);
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "radial-gradient(ellipse at 50% 0%, rgba(0,229,160,0.06) 0%, #0A0A0F 55%)" }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl p-8 border space-y-4"
        style={{ background: "#16161F", borderColor: "#1E1E2E" }}
      >
        <div>
          <h1 className="text-xl font-semibold text-white">访问口令</h1>
          <p className="text-gray-500 text-xs mt-1">CORAL Strategy Protocol</p>
        </div>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="输入口令"
          autoFocus
          className="w-full rounded-xl px-4 py-3 text-white text-sm outline-none"
          style={{ background: "#0A0A0F", border: "1.5px solid #1E1E2E" }}
        />
        {err && (
          <p
            className="text-xs rounded-lg px-3 py-2"
            style={{ color: "#FF6B8A", background: "rgba(255,77,106,0.08)" }}
          >
            {err}
          </p>
        )}
        <button
          type="submit"
          disabled={loading || !password}
          className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50"
          style={{ background: "linear-gradient(135deg, #00E5A0, #00C080)", color: "#0A0A0F" }}
        >
          {loading ? "登录中…" : "登录"}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
