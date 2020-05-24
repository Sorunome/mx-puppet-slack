import { Store } from "mx-puppet-bridge";
import { IStoreToken } from "soru-slack-client";
import {DbThreadStore} from "./db/DbThreadStore";

const CURRENT_SCHEMA = 2;

export class SlackStore {
	constructor(
		private store: Store,
	) { }

	private pThreadStore: DbThreadStore

	get threadStore(): DbThreadStore {
		return this.pThreadStore;
	}

	public async init(): Promise<void> {
		await this.store.init(CURRENT_SCHEMA, "slack_schema", (version: number) => {
			return require(`./db/schema/v${version}.js`).Schema;
		}, false);

		this.pThreadStore = new DbThreadStore(this.store.db)
	}

	public async getTokens(puppetId: number): Promise<IStoreToken[]> {
		const rows = await this.store.db.All("SELECT * FROM slack_tokenstore WHERE puppet_id = $p", { p: puppetId });
		const ret: IStoreToken[] = [];
		for (const row of rows) {
			if (row) {
				ret.push({
					token: row.token as string,
					teamId: row.team_id as string,
					userId: row.user_id as string,
				});
			}
		}
		return ret;
	}

	public async storeToken(puppetId: number, token: IStoreToken) {
		const exists = await this.store.db.Get("SELECT 1 FROM slack_tokenstore WHERE puppet_id = $p AND token = $t",
			{ p: puppetId, t: token.token });
		if (exists) {
			return;
		}
		await this.store.db.Run(`INSERT INTO slack_tokenstore (
			puppet_id, token, team_id, user_id
		) VALUES (
			$puppetId, $token, $teamId, $userId
		)`, {
			puppetId,
			token: token.token,
			teamId: token.teamId,
			userId: token.userId,
		});
	}
}
