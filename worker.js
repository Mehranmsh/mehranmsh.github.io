
const ALLOWED_ORIGIN = "https://mehranmsh.github.io";
const PI_ME_URL = "https://api.minepi.com/v2/me";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
      "Cache-Control": "no-store"
    }
  });
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin");

    if (origin && origin !== ALLOWED_ORIGIN) {
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Vary": "Origin"
        }
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        status: "online",
        service: "MEHRAN MSH AUTH",
        version: "1.1"
      });
    }

    if (url.pathname !== "/auth" || request.method !== "POST") {
      return json({ error: "Not found" }, 404);
    }

    try {
      const body = await request.json();
      const accessToken = body?.accessToken;

      if (
        typeof accessToken !== "string" ||
        accessToken.length < 10 ||
        accessToken.length > 4096
      ) {
        return json({ error: "Invalid access token" }, 400);
      }

      const piResponse = await fetch(PI_ME_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        }
      });

      if (!piResponse.ok) {
        return json({
          success: false,
          error: "Pi authentication failed"
        }, 401);
      }

      const user = await piResponse.json();

      if (
        typeof user.uid !== "string" ||
        typeof user.username !== "string"
      ) {
        return json({
          success: false,
          error: "Invalid Pi user data"
        }, 401);
      }

      const isAdmin =
        user.username.trim().toLowerCase() === "mehranmsh";

      return json({
        success: true,
        uid: user.uid,
        username: user.username,
        isAdmin
      });

    } catch (error) {
      return json({
        success: false,
        error: "Authentication service error"
      }, 500);
    }
  }
};
