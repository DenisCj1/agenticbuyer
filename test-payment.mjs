import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { withX402Client } from "agents/x402";
import { privateKeyToAccount } from "viem/accounts";
import { toClientEvmSigner } from "@x402/evm";

const privateKey = readFileSync(
	".wallets/base-sepolia-buyer-private-key.txt",
	"utf8",
).trim();

const account = privateKeyToAccount(privateKey);

const client = new Client({
	name: "AgenticBuyer Test Buyer",
	version: "1.0.0",
});

const transport = new StreamableHTTPClientTransport(
	new URL("https://agenticbuyer.agenticbuyer.workers.dev/paid-mcp"),
);

await client.connect(transport);

const paidClient = withX402Client(client, {
	network: "base-sepolia",
	account: toClientEvmSigner(account),
	maxPaymentValue: 100000n,
});

console.log("CONNECTED_TO_AGENTICBUYER");

const result = await paidClient.callTool(
	async () => {
		console.log("PAYMENT_REQUIRED");
		console.log("APPROVING_TEST_PAYMENT");
		return true;
	},
	{
		name: "buyer_quote",
		arguments: {
			query: "data API",
			budgetUsd: 1,
			network: "base",
			limit: 10,
		},
	},
);

console.log("PAYMENT_RESULT");
console.dir(result, { depth: null });

await client.close();