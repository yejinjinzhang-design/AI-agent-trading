/**
 * 最小口令登录代理（Next.js 16 的 proxy 文件约定）
 * 仅当 APP_PASSWORD 环境变量存在时启用；本地开发默认不拦截。
 */
import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, expectedToken } from "@/lib/auth-token";

export const config = {
  matcher: [
    "/((?!_next/|favicon.ico|login|api/auth/).*)",
  ],
};

export function proxy(req: NextRequest) {
  const password = process.env.APP_PASSWORD?.trim();
  if (!password) return NextResponse.next();

  const token = req.cookies.get(AUTH_COOKIE)?.value;
  if (token && token === expectedToken(password)) {
    return NextResponse.next();
  }

  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", req.nextUrl.pathname);
  return NextResponse.redirect(url);
}
