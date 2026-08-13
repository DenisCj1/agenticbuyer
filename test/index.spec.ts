import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, {
	buildBazaarSearchUrl,
	decideCandidates,
	getIncomingPaymentStatus,
	getSpendGateStatus,
	isSafeProviderUrl,
	normalizeNetwork,
	rankBazaarResources,
	usdcAssetForNetwork,
	validateProviderPaymentRequirement,
	type BazaarResource,
} from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

describe("AgenticBuyer worker", () => {
	it("returns a healthy v0.9 response", async () => {
		const request = new IncomingRequest("http://example.com/health");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "ok",
			service: "AgenticBuyer",
			version: "0.9.0",
		});
	});

	it("exposes guarded downstream execution capabilities", async () => {
		const response = await SELF.fetch("https://example.com/");
		const body = (await response.json()) as {
			version: string;
			tools: { paid: string[] };
			network: string;
			capabilities: Record<string, boolean | number>;
		};

		expect(body.version).toBe("0.9.0");
		expect(body.tools.paid).toContain("buyer_execute");
		expect(body.capabilities.downstreamExecution).toBe(true);
		expect(body.capabilities.liveSpendGate).toBe(true);
		expect(body.capabilities.hardProviderSpendCapUsd).toBe(0.01);
		expect(body.capabilities.dailyProviderSpendCapUsd).toBe(0.05);
		expect(body.capabilities.duplicatePurchaseProtection).toBe(true);
		expect(body.capabilities.persistentSpendLedger).toBe(true);
		expect(body.network).toBe("eip155:8453");
		expect(body.capabilities.cdpFacilitator).toBe(true);
	});

	it("keeps live spending locked by default", async () => {
		const response = await SELF.fetch("https://example.com/spend-status");
		const body = (await response.json()) as {
			liveSpendEnabled: boolean;
			hardMaxProviderSpendUsd: number;
		};

		expect(body.liveSpendEnabled).toBe(false);
		expect(body.hardMaxProviderSpendUsd).toBe(0.01);
	});
});

describe("AgenticBuyer production incoming payment configuration", () => {
	it("requires both CDP credentials and keeps provider spending locked", () => {
		const missing = getIncomingPaymentStatus({
			PAY_TO: "0x0000000000000000000000000000000000000000",
			X402_NETWORK: "eip155:8453",
		} as never);

		expect(missing.productionIncomingPaymentsConfigured).toBe(false);
		expect(missing.network).toBe("eip155:8453");
		expect(missing.liveProviderSpendEnabled).toBe(false);

		const configured = getIncomingPaymentStatus({
			PAY_TO: "0x0000000000000000000000000000000000000000",
			X402_NETWORK: "eip155:8453",
			CDP_API_KEY_ID: "test-id",
			CDP_API_KEY_SECRET: "test-secret",
		} as never);

		expect(configured.productionIncomingPaymentsConfigured).toBe(true);
		expect(configured.liveProviderSpendEnabled).toBe(false);
	});
});

describe("network and USDC resolution", () => {
	it("normalizes Base network identifiers", () => {
		expect(normalizeNetwork("base")).toBe("eip155:8453");
		expect(normalizeNetwork("base-sepolia")).toBe("eip155:84532");
	});

	it("resolves official Base USDC contract addresses", () => {
		expect(usdcAssetForNetwork("base")).toBe(BASE_USDC);
		expect(usdcAssetForNetwork("base-sepolia")).toBe(
			"0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		);
	});
});

describe("AgenticBuyer Bazaar routing", () => {
	it("uses the Base USDC asset address", () => {
		const url = new URL(
			buildBazaarSearchUrl({
				query: "crypto news",
				budgetUsd: 1,
				network: "base",
				limit: 10,
			}),
		);

		expect(url.searchParams.get("network")).toBe("eip155:8453");
		expect(url.searchParams.get("asset")).toBe(BASE_USDC);
		expect(url.searchParams.get("maxUsdPrice")).toBe("1");
	});

	it("can build a filter-only inventory fallback", () => {
		const url = new URL(
			buildBazaarSearchUrl({
				query: "crypto news",
				network: "base",
				limit: 20,
				includeQuery: false,
			}),
		);

		expect(url.searchParams.has("query")).toBe(false);
		expect(url.searchParams.get("network")).toBe("eip155:8453");
		expect(url.searchParams.get("limit")).toBe("20");
	});

	it("ranks text relevance, quality, and price", () => {
		const resources: BazaarResource[] = [
			{
				resource: "https://example.com/weather",
				description: "Weather forecast",
				accepts: [
					{
						scheme: "exact",
						network: "eip155:8453",
						asset: BASE_USDC,
						amount: "10000",
						payTo: "0x1111111111111111111111111111111111111111",
					},
				],
			},
			{
				resource: "https://example.com/news",
				description: "Crypto news and market intelligence",
				accepts: [
					{
						scheme: "exact",
						network: "eip155:8453",
						asset: BASE_USDC,
						amount: "20000",
						payTo: "0x2222222222222222222222222222222222222222",
					},
				],
				quality: { l30DaysTotalCalls: 1000, l30DaysUniquePayers: 100 },
			},
		];

		const ranked = rankBazaarResources(resources, 1, "crypto news", "base");
		expect(ranked[0]?.resource).toBe("https://example.com/news");
		expect(ranked[0]?.estimatedUsdPrice).toBe(0.02);
		expect(ranked[0]?.textRelevance).toBeGreaterThan(0);
	});

	it("enforces the requested budget", () => {
		const resources: BazaarResource[] = [
			{
				resource: "https://example.com/cheap",
				description: "Crypto news",
				accepts: [
					{
						scheme: "exact",
						network: "base",
						asset: BASE_USDC,
						amount: "20000",
						payTo: "0x1111111111111111111111111111111111111111",
					},
				],
			},
			{
				resource: "https://example.com/expensive",
				description: "Crypto news",
				accepts: [
					{
						scheme: "exact",
						network: "eip155:8453",
						asset: BASE_USDC,
						amount: "120000",
						payTo: "0x2222222222222222222222222222222222222222",
					},
				],
			},
		];

		const decision = decideCandidates(resources, 0.05, "crypto news", "base");
		expect(decision.selected?.resource).toBe("https://example.com/cheap");
		expect(decision.overBudgetAlternatives[0]?.budgetGapUsd).toBe(0.07);
	});
});

describe("AgenticBuyer provider purchase safety", () => {
	const selected: BazaarResource = {
		resource: "https://x402.example.com/crypto-news",
		description: "Crypto news",
		accepts: [
			{
				scheme: "exact",
				network: "eip155:8453",
				asset: BASE_USDC,
				amount: "1000",
				payTo: "0x3333333333333333333333333333333333333333",
			},
		],
	};

	it("allows a discovered Base USDC payment under the hard cap", () => {
		const validation = validateProviderPaymentRequirement({
			selected,
			paymentResourceUrl: selected.resource,
			requirement: selected.accepts![0]!,
			maxProviderSpendUsd: 0.01,
		});

		expect(validation.ok).toBe(true);
		expect(validation.amountUsd).toBe(0.001);
	});

	it("rejects a provider price increase after discovery", () => {
		const validation = validateProviderPaymentRequirement({
			selected,
			paymentResourceUrl: selected.resource,
			requirement: {
				...selected.accepts![0]!,
				amount: "11000",
			},
			maxProviderSpendUsd: 0.01,
		});

		expect(validation.ok).toBe(false);
		expect(validation.reason).toContain("above");
	});

	it("rejects changed payment details after discovery", () => {
		const validation = validateProviderPaymentRequirement({
			selected,
			paymentResourceUrl: selected.resource,
			requirement: {
				...selected.accepts![0]!,
				payTo: "0x4444444444444444444444444444444444444444",
			},
			maxProviderSpendUsd: 0.01,
		});

		expect(validation.ok).toBe(false);
		expect(validation.reason).toContain("changed");
	});

	it("blocks unsafe provider URLs", () => {
		expect(isSafeProviderUrl("https://api.example.com/data")).toBe(true);
		expect(isSafeProviderUrl("http://api.example.com/data")).toBe(false);
		expect(isSafeProviderUrl("https://localhost/data")).toBe(false);
		expect(isSafeProviderUrl("https://127.0.0.1/data")).toBe(false);
		expect(isSafeProviderUrl("https://192.168.1.10/data")).toBe(false);
	});

	it("requires the receiving wallet to match the secured buyer key", () => {
		const testPrivateKey = `0x${"11".repeat(32)}`;
		const first = getSpendGateStatus({
			PAY_TO: "0x0000000000000000000000000000000000000000",
			X402_NETWORK: "base-sepolia",
			AGENTICBUYER_BUYER_PRIVATE_KEY: testPrivateKey,
			SPEND_LEDGER: {},
		} as never);

		expect(first.buyerWalletConfigured).toBe(true);
		expect(first.receivingWalletMatchesBuyer).toBe(false);
		expect(first.buyerWalletAddress).not.toBeNull();

		const matched = getSpendGateStatus({
			PAY_TO: first.buyerWalletAddress!,
			X402_NETWORK: "base-sepolia",
			AGENTICBUYER_BUYER_PRIVATE_KEY: testPrivateKey,
			SPEND_LEDGER: {},
		} as never);

		expect(matched.receivingWalletMatchesBuyer).toBe(true);
		expect(matched.liveSpendEnabled).toBe(false);
		expect(matched.readyToArm).toBe(true);
	});
});


describe("AgenticBuyer persistent spend ledger", () => {
	type LedgerStub = {
		fetch(input: string, init?: RequestInit): Promise<Response>;
	};

	function newLedger() {
		const namespace = (env as unknown as {
			SPEND_LEDGER: {
			idFromName(name: string): unknown;
			get(id: unknown): LedgerStub;
		};
		}).SPEND_LEDGER;
		const id = namespace.idFromName(`test-${crypto.randomUUID()}`);
		return namespace.get(id);
	}

	it("blocks an identical purchase inside the duplicate window", async () => {
		const ledger = newLedger();
		const body = {
			fingerprint: "abc123",
			amountUsd: 0.001,
			provider: "https://x402.example.com/data",
		};

		const first = await ledger.fetch("https://ledger/reserve", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const firstBody = (await first.json()) as {
			allowed: boolean;
			reason: string;
		};

		const second = await ledger.fetch("https://ledger/reserve", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const secondBody = (await second.json()) as {
			allowed: boolean;
			reason: string;
		};

		expect(firstBody.allowed).toBe(true);
		expect(secondBody.allowed).toBe(false);
		expect(secondBody.reason).toBe("DUPLICATE_PURCHASE");
	});

	it("enforces the five-cent daily provider-spend ceiling", async () => {
		const ledger = newLedger();

		for (let i = 0; i < 5; i += 1) {
			const response = await ledger.fetch("https://ledger/reserve", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					fingerprint: `daily-${i}`,
					amountUsd: 0.01,
					provider: `https://x402.example.com/data-${i}`,
				}),
			});
			const body = (await response.json()) as { allowed: boolean };
			expect(body.allowed).toBe(true);
		}

		const blocked = await ledger.fetch("https://ledger/reserve", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				fingerprint: "daily-6",
				amountUsd: 0.001,
				provider: "https://x402.example.com/data-6",
			}),
		});
		const blockedBody = (await blocked.json()) as {
			allowed: boolean;
			reason: string;
		};

		expect(blockedBody.allowed).toBe(false);
		expect(blockedBody.reason).toBe("DAILY_SPEND_LIMIT_REACHED");
	});
});
