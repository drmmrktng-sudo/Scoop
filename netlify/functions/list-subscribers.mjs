// netlify/functions/list-subscribers.mjs
// Admin endpoint — returns all subscribers as CSV
// Access: https://myscoopdeals.com/api/subscribers?key=YOUR_ADMIN_KEY
// Set ADMIN_KEY in Netlify environment variables

export default async function handler(req) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");

  // Check admin key (set ADMIN_KEY in Netlify env vars)
  const adminKey = process.env.ADMIN_KEY || "scoopdeals2026";
  if (key !== adminKey) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("subscribers");

    // List all subscribers
    const { blobs } = await store.list();
    const subscribers = [];

    for (const blob of blobs) {
      const data = await store.get(blob.key, { type: "json" });
      if (data) subscribers.push(data);
    }

    // Sort by date
    subscribers.sort((a, b) => new Date(a.date) - new Date(b.date));

    const format = url.searchParams.get("format") || "csv";

    if (format === "json") {
      return new Response(JSON.stringify({ count: subscribers.length, subscribers }, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Default: CSV
    const csv = [
      "Email,Source,Date,IP",
      ...subscribers.map(s => `${s.email},${s.source},${s.date},${s.ip}`)
    ].join("\n");

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="scoop-subscribers-${new Date().toISOString().split("T")[0]}.csv"`
      }
    });

  } catch (err) {
    console.error("list-subscribers error:", err);
    return new Response("Error: " + err.message, { status: 500 });
  }
}

export const config = { path: "/api/subscribers" };
