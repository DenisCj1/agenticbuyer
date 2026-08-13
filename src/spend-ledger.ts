import { DurableObject } from "cloudflare:workers";

const DAILY_LIMIT_MICROS = 50_000;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

type ReservationStatus = "reserved" | "settled" | "failed";

type ReservationRecord = {
	fingerprint: string;
	amountMicros: number;
	provider: string;
	status: ReservationStatus;
	createdAt: number;
	updatedAt: number;
	day: string;
};

type ActiveReservation = {
	amountMicros: number;
	createdAt: number;
};

type DailyState = {
	day: string;
	spentMicros: number;
	reservedMicros: number;
	settledCount: number;
	attemptCount: number;
	active: Record<string, ActiveReservation>;
};

type ReserveRequest = {
	fingerprint: string;
	amountUsd: number;
	provider: string;
};

type FinalizeRequest = {
	fingerprint: string;
	status: "settled" | "failed";
	paymentStatus?: string | null;
};

function utcDay(now: number) {
	return new Date(now).toISOString().slice(0, 10);
}

function toMicros(amountUsd: number) {
	return Math.round(amountUsd * 1_000_000);
}

function toUsd(amountMicros: number) {
	return Math.round(amountMicros) / 1_000_000;
}

function defaultDailyState(day: string): DailyState {
	return {
		day,
		spentMicros: 0,
		reservedMicros: 0,
		settledCount: 0,
		attemptCount: 0,
		active: {},
	};
}

function cleanExpiredReservations(state: DailyState, now: number) {
	let changed = false;

	for (const [fingerprint, active] of Object.entries(state.active)) {
		if (now - active.createdAt >= DUPLICATE_WINDOW_MS) {
			delete state.active[fingerprint];
			changed = true;
		}
	}

	if (changed) {
		state.reservedMicros = Object.values(state.active).reduce(
			(total, active) => total + active.amountMicros,
			0,
		);
	}

	return changed;
}

function providerHost(provider: string) {
	try {
		return new URL(provider).hostname;
	} catch {
		return "invalid";
	}
}

export class SpendLedger extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/status") {
			return this.status();
		}

		if (request.method === "POST" && url.pathname === "/reserve") {
			const body = (await request.json()) as ReserveRequest;
			return this.reserve(body);
		}

		if (request.method === "POST" && url.pathname === "/finalize") {
			const body = (await request.json()) as FinalizeRequest;
			return this.finalize(body);
		}

		return Response.json({ error: "NOT_FOUND" }, { status: 404 });
	}

	private async status() {
		const now = Date.now();
		const day = utcDay(now);
		const key = `day:${day}`;

		const state = await this.ctx.storage.transaction(async (txn) => {
			const current = (await txn.get<DailyState>(key)) ?? defaultDailyState(day);
			if (cleanExpiredReservations(current, now)) {
				await txn.put(key, current);
			}
			return current;
		});

		return Response.json({
			day,
			dailyLimitUsd: toUsd(DAILY_LIMIT_MICROS),
			spentUsd: toUsd(state.spentMicros),
			reservedUsd: toUsd(state.reservedMicros),
			remainingUsd: toUsd(
				Math.max(
					0,
					DAILY_LIMIT_MICROS - state.spentMicros - state.reservedMicros,
				),
			),
			settledCount: state.settledCount,
			attemptCount: state.attemptCount,
			activeReservations: Object.keys(state.active).length,
			duplicateWindowMinutes: DUPLICATE_WINDOW_MS / 60_000,
		});
	}

	private async reserve(body: ReserveRequest) {
		const now = Date.now();
		const day = utcDay(now);
		const dailyKey = `day:${day}`;
		const reservationKey = `reservation:${body.fingerprint}`;
		const amountMicros = toMicros(body.amountUsd);

		if (
			!body.fingerprint ||
			!Number.isFinite(body.amountUsd) ||
			amountMicros <= 0 ||
			amountMicros > 10_000
		) {
			return Response.json({
				allowed: false,
				reason: "INVALID_RESERVATION",
			});
		}

		const result = await this.ctx.storage.transaction(async (txn) => {
			const state =
				(await txn.get<DailyState>(dailyKey)) ?? defaultDailyState(day);
			cleanExpiredReservations(state, now);

			const existing = await txn.get<ReservationRecord>(reservationKey);
			if (
				existing &&
				(existing.status === "reserved" || existing.status === "settled") &&
				now - existing.createdAt < DUPLICATE_WINDOW_MS
			) {
				return {
					allowed: false as const,
					reason: "DUPLICATE_PURCHASE",
					day,
					spentUsd: toUsd(state.spentMicros),
					reservedUsd: toUsd(state.reservedMicros),
				};
			}

			if (
				state.spentMicros + state.reservedMicros + amountMicros >
				DAILY_LIMIT_MICROS
			) {
				return {
					allowed: false as const,
					reason: "DAILY_SPEND_LIMIT_REACHED",
					day,
					spentUsd: toUsd(state.spentMicros),
					reservedUsd: toUsd(state.reservedMicros),
					dailyLimitUsd: toUsd(DAILY_LIMIT_MICROS),
				};
			}

			state.active[body.fingerprint] = {
				amountMicros,
				createdAt: now,
			};
			state.reservedMicros += amountMicros;
			state.attemptCount += 1;

			const record: ReservationRecord = {
				fingerprint: body.fingerprint,
				amountMicros,
				provider: body.provider,
				status: "reserved",
				createdAt: now,
				updatedAt: now,
				day,
			};

			await txn.put(dailyKey, state);
			await txn.put(reservationKey, record);

			return {
				allowed: true as const,
				reason: "RESERVED",
				day,
				amountUsd: toUsd(amountMicros),
				spentUsd: toUsd(state.spentMicros),
				reservedUsd: toUsd(state.reservedMicros),
				remainingUsd: toUsd(
					DAILY_LIMIT_MICROS - state.spentMicros - state.reservedMicros,
				),
			};
		});

		console.log({
			event: "agenticbuyer_spend_ledger",
			action: "reserve",
			allowed: result.allowed,
			reason: result.reason,
			fingerprint: body.fingerprint,
			amountUsd: body.amountUsd,
			providerHost: providerHost(body.provider),
		});

		return Response.json(result);
	}

	private async finalize(body: FinalizeRequest) {
		const now = Date.now();
		const reservationKey = `reservation:${body.fingerprint}`;

		const result = await this.ctx.storage.transaction(async (txn) => {
			const record = await txn.get<ReservationRecord>(reservationKey);

			if (!record) {
				return {
					ok: false as const,
					reason: "RESERVATION_NOT_FOUND",
				};
			}

			if (record.status !== "reserved") {
				return {
					ok: true as const,
					reason: "ALREADY_FINALIZED",
					status: record.status,
				};
			}

			const dailyKey = `day:${record.day}`;
			const state =
				(await txn.get<DailyState>(dailyKey)) ?? defaultDailyState(record.day);

			const active = state.active[body.fingerprint];
			if (active) {
				state.reservedMicros = Math.max(
					0,
					state.reservedMicros - active.amountMicros,
				);
				delete state.active[body.fingerprint];
			}

			if (body.status === "settled") {
				state.spentMicros += record.amountMicros;
				state.settledCount += 1;
			}

			record.status = body.status;
			record.updatedAt = now;

			await txn.put(dailyKey, state);
			await txn.put(reservationKey, record);

			return {
				ok: true as const,
				reason: body.status === "settled" ? "SETTLED" : "RELEASED",
				status: body.status,
				amountUsd: toUsd(record.amountMicros),
				spentUsd: toUsd(state.spentMicros),
				reservedUsd: toUsd(state.reservedMicros),
				remainingUsd: toUsd(
					Math.max(
						0,
						DAILY_LIMIT_MICROS - state.spentMicros - state.reservedMicros,
					),
				),
			};
		});

		console.log({
			event: "agenticbuyer_spend_ledger",
			action: "finalize",
			fingerprint: body.fingerprint,
			status: body.status,
			paymentStatus: body.paymentStatus ?? null,
			result: result.reason,
		});

		return Response.json(result);
	}
}