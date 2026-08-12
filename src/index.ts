import { McpServer } from "@modelcontextprotocol/server";
import { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLegacyMcpHandler } from "agents/mcp";
import { createMcpHandler } from "agents/mcp/server";
import { withX402, type X402Config } from "agents/x402";
import { z } from "zod";

function createServer() {
	const server = new McpServer({
		name: "AgenticBuyer",
		version: "0.3.0",
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
			version: "0.3.0",
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

	return server;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return Response.json({
				status: "ok",
				service: "AgenticBuyer",
				version: "0.3.0",
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
			version: "0.3.0",
			mcp: "/mcp",
			paidMcp: "/paid-mcp",
			network: env.X402_NETWORK,
		});
	},
} satisfies ExportedHandler<Env>;