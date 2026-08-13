import { McpServer } from "@modelcontextprotocol/server";
import { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLegacyMcpHandler } from "agents/mcp";
import { createMcpHandler } from "agents/mcp/server";
import { withX402, type X402Config } from "agents/x402";
import { z } from "zod";

const VERSION = "0.4.0";
const BAZAAR_SEARCH_ENDPOINT =
	"https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";

type BazaarPaymentRequirement = {
	scheme?: string;
	network?: string;
	amount?: string;
	asset?: string;
	payTo?: string;
	maxTimeoutSeconds?: number;
};

type BazaarQuality = {
	l30DaysTotalCalls?: number;
	l30DaysUniquePayers?: number;
	lastCalledAt?: string;
};

export type BazaarResource = {
	resource: string;
	description?: string;
	type?: string;
	x402Version?: number;
	lastUpdated?: string;
	accepts?: BazaarPaymentRequirement[];
	quality?: BazaarQuality;
	serviceName?: string;
	tags?: string[];
};

type BazaarSearchResponse = {
	x402Version?: number;
	resources?: BazaarResource[];
	partialResults?: boolean;
	searchMethod?: string;
};

export type RankedResource = BazaarResource & {
	agenticBuyerScore: number;
	estimatedUsdPrice: number | null;
};

function usdcAmountToUsd(amount?: string): number | null {
	if (!amount || !/^\d+$/.test(amount)) return null;

	try {
		const atomic = BigInt(amount);
		const whole = atomic / 1_000_000n;
		const fraction = atomic % 1_000_000n;
		return Number(whole) + Number(fraction) / 1_000_000;
	} catch {
		return null;
	}
}

function lowestUsdcPrice(resource: BazaarResource): number | null {
	const prices = (resource.accepts ?? [])
		.map((requirement) => usdcAmountToUsd(requirement.amount))
		.filter((price): price is number => price !== null && Number.isFinite(price));

	return prices.length > 0 ? Math.min(...prices) : null;
}

export function rankBazaarResources(
	resources: BazaarResource[],
	budgetUsd: number,
): RankedResource[] {
	return resources
		.map((resource, index) => {
			const price = lowestUsdcPrice(resource);
			const calls = Math.max(0, resource.quality?.l30DaysTotalCalls ?? 0);
			const payers = Math.max(0, resource.quality?.l30DaysUniquePayers ?? 0);

			const relevanceScore = Math.max(0, 40 - index * 5);
			const priceScore =
				price !== null && budgetUsd > 0
					? Math.max(0, 25 * (1 - Math.min(price / budgetUsd, 1)))
					: 0;
			const payerScore = Math.min(20, Math.log10(payers + 1) * 10);
			const usageScore = Math.min(15, Math.log10(calls + 1) * 5);

			return {
				...resource,
				agenticBuyerScore: Math.round(
					(relevanceScore + priceScore + payerScore + usageScore) * 100,
				) / 100,
				estimatedUsdPrice: price,
			};
		})
		.sort((a, b) => b.agenticBuyerScore - a.agenticBuyerScore);
}

export function buildBazaarSearchUrl({
	query,
	budgetUsd,
	network = "base",
	limit = 5,
}: {
	query: string;
	budgetUsd: number;
	network?: string;
	limit?: number;
}) {
	const url = new URL(BAZAAR_SEARCH_ENDPOINT);
	url.searchParams.set("query", query.trim());
	url.searchParams.set("network", network);
	url.searchParams.set("asset", "usdc");
	url.searchParams.set("maxUsdPrice", String(budgetUsd));
	url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 10)));
	return url.toString();
}

async function createBuyerQuote({
	query,
	budgetUsd,
	network,
	limit,
}: {
	query: string;
	budgetUsd: number;
	network: string;
	limit: number;
}) {
	const searchUrl = buildBazaarSearchUrl({
		query,
		budgetUsd,
		network,
		limit,
	});

	const response = await fetch(searchUrl, {
		headers: {
			accept: "application/json",
		},
	});

	if (!response.ok) {
		throw new Error(`x402 Bazaar search failed with HTTP ${response.status}.`);
	}

	const data = (await response.json()) as BazaarSearchResponse;
	const ranked = rankBazaarResources(data.resources ?? [], budgetUsd);
	const selected = ranked[0] ?? null;

	return {
		service: "AgenticBuyer",
		version: VERSION,
		quoteType: "x402-provider-route",
		query,
		budgetUsd,
		network,
		currency: "USDC",
		selected,
		alternatives: ranked.slice(1, 5),
		candidateCount: ranked.length,
		partialResults: data.partialResults ?? false,
		searchMethod: data.searchMethod ?? "unknown",
		executionReady: false,
		nextAction: selected
			? "Use the selected provider details for a downstream purchase. Automatic provider payment is the next AgenticBuyer milestone."
			: "No provider matched this request and budget. Increase the budget or broaden the query.",
	};
}

function createServer() {
	const server = new McpServer({
		name: "AgenticBuyer",
		version: VERSION,
	});

	server.registerTool(
		"buyer_ping",
		{
			description: "Check that the AgenticBuyer MCP service is online.",
			inputSchema: {
				message: z.string().optional(),
			},
		},
		async ({ message }) => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						service: "AgenticBuyer",
						status: "online",
						message: message ?? "AgenticBuyer MCP is working.",
					}),
				},
			],
		}),
	);

	return server;
}

function createPaidServer(env: Env) {
	const config: X402Config = {
		network: env.X402_NETWORK as X402Config["network"],
		recipient: env.PAY_TO,
		facilitator: {
			url: "https://x402.org/facilitator",
		},
	};

	const server = withX402(
		new LegacyMcpServer({
			name: "AgenticBuyer Paid",
			version: VERSION,
		}),
		config,
	);

	server.paidTool(
		"buyer_paid_test",
		"Test AgenticBuyer x402 machine payment.",
		0.01,
		{
			request: z.string(),
		},
		{},
		async ({ request }) => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						service: "AgenticBuyer",
						paid: true,
						request,
						message: "x402 payment accepted. AgenticBuyer executed the paid tool.",
					}),
				},
			],
		}),
	);

	server.paidTool(
		"buyer_quote",
		"Search the x402 Bazaar, enforce a provider budget, score candidates, and return AgenticBuyer's preferred provider route. This quote does not execute the downstream provider purchase yet.",
		0.01,
		{
			query: z.string().min(2).max(300),
			budgetUsd: z.number().positive().max(10),
			network: z.string().optional(),
			limit: z.number().int().min(1).max(10).optional(),
		},
		{},
		async ({ query, budgetUsd, network, limit }) => {
			try {
				const quote = await createBuyerQuote({
					query,
					budgetUsd,
					network: network ?? "base",
					limit: limit ?? 5,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(quote),
						},
					],
				};
			} catch (error) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: JSON.stringify({
								service: "AgenticBuyer",
								error: "QUOTE_UNAVAILABLE",
								message:
									error instanceof Error
										? error.message
										: "AgenticBuyer could not create a provider quote.",
							}),
						},
					],
				};
			}
		},
	);

	return server;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return Response.json({
				status: "ok",
				service: "AgenticBuyer",
				version: VERSION,
			});
		}

		if (url.pathname === "/mcp") {
			return createMcpHandler(createServer)(request, env, ctx);
		}

		if (url.pathname === "/paid-mcp") {
			return createLegacyMcpHandler(createPaidServer(env), {
				route: "/paid-mcp",
			})(request, env, ctx);
		}

		return Response.json({
			name: "AgenticBuyer",
			message: "AgenticBuyer is online.",
			status: "building",
			version: VERSION,
			mcp: "/mcp",
			paidMcp: "/paid-mcp",
			network: env.X402_NETWORK,
			tools: {
				free: ["buyer_ping"],
				paid: ["buyer_paid_test", "buyer_quote"],
			},
		});
	},
} satisfies ExportedHandler<Env>;
