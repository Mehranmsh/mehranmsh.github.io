
const ALLOWED_ORIGIN = "https://mehranmsh.github.io";

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin");

    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json",
      "Vary": "Origin"
    };

    if (origin && origin !== ALLOWED_ORIGIN) {
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json(
        { status: "online", service: "MEHRAN MSH AUTH" },
        { headers: cors }
      );
    }

    if (url.pathname !== "/auth" || request.method !== "POST") {
      return Response.json(
        { error: "Not found" },
        { status: 404, headers: cors }
      );
    }

    try {
      const body = await request.json();
      const accessToken = body.accessToken;

      if (
        typeof accessToken !== "string" ||
        accessToken.length < 10 ||
        accessToken.length > 4096
      ) {
        return Response.json(
          { error: "Invalid access token" },
          { status: 400, headers: cors }
        );
      }

      const piResponse = await fetch(
        "https://api.minepi.com/v2/me",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        }
      );

      if (!piResponse.ok) {
        return Response.json(
          { error: "Pi authentication failed" },
          { status: 401, headers: cors }
        );
      }

      const user = await piResponse.json();

      if (!user.uid || !user.username) {
        return Response.json(
          { error: "Invalid Pi user data" },
          { status: 401, headers: cors }
        );
      }

      return Response.json({
        success: true,
        uid: user.uid,
        username: user.username,
        isAdmin:
          user.username.toLowerCase() === "mehranmsh"
      }, { headers: cors });

    } catch (error) {
      return Response.json(
        { error: "Authentication service error" },
        { status: 500, headers: cors }
      );
    }
  }
};
