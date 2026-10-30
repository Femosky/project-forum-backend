// User agents that aren't people: crawlers, link unfurlers and chat-app previews. Their requests count as no
// views and no visits.
export const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|headless|lighthouse|curl|wget|python-requests|axios|node-fetch/i;

export const isBot = (userAgent: string | undefined) => !userAgent || BOT_UA.test(userAgent);
