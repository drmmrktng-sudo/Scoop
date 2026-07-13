// netlify/functions/collect-email.mjs
// Collects email signups and stores them in Netlify Blobs
// Each email is stored as: subscribers:{email} = { email, source, date, ip }
// List all subscribers via the admin endpoint

export default async function handler(req) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "https://myscoopdeals.com",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const email = (body.email || "").trim().toLowerCase();
    const source = body.source || "homepage-sidebar";

    // Basic email validation
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ error: "Invalid email address" }), { status: 400, headers: corsHeaders });
    }

    // Store in Netlify Blobs
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("subscribers");

    // Check if already subscribed
    const existing = await store.get(email).catch(() => null);
    if (existing) {
      return new Response(JSON.stringify({ ok: true, message: "already_subscribed" }), { status: 200, headers: corsHeaders });
    }

    // Save subscriber
    const subscriber = {
      email,
      source,
      date: new Date().toISOString(),
      ip: req.headers.get("x-nf-client-connection-ip") || "unknown"
    };

    await store.setJSON(email, subscriber);

    // Log for Netlify function logs (visible in dashboard)
    console.log("NEW SUBSCRIBER:", email, "from:", source, "at:", subscriber.date);

    return new Response(JSON.stringify({ ok: true, message: "subscribed" }), { status: 200, headers: corsHeaders });

  } catch (err) {
    console.error("collect-email error:", err.message);
    return new Response(JSON.stringify({ error: "Server error" }), { status: 500, headers: corsHeaders });
  }
}

export const config = { path: "/api/subscribe" };
