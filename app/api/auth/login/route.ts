import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, expectedToken } from "@/lib/auth-token";

export async function POST(req: NextRequest) {
  const password = process.env.APP_PASSWORD?.trim();
  if (!password) {
    return NextResponse.json({ ok: true, disabled: true });
  }
  const body = await req.json().catch(() => ({}));
  const input = typeof body.password === "string" ? body.password : "";
  if (input !== password) {
    return NextResponse.json({ error: "口令错误" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, expectedToken(password), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
