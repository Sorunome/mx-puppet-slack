import { IDbSchema, Store, Log, Util } from "mx-puppet-bridge";
import { Puppet } from "../../index";

const log = new Log("SlackMigration");

const LEVEL_OP = 100;

export class Schema implements IDbSchema {
	public description = "tokenstore";
	public async run(store: Store) {
		const puppet = Puppet();
		const allPuppets = await puppet.provisioner.getAll();
		let delay = puppet.config.limits.roomUserAutojoinDelay;
		for (const p of allPuppets) {
			log.info(`Migrating puppetId=${p.puppetId}...`);
			const teamId = (p.data.team as any).id;
			const rooms = await store.roomStore.getByPuppetId(p.puppetId);
			for (const room of rooms) {
				log.info(`Migrating room ${room.mxid}...`);
				const opClient = await puppet.roomSync.getRoomOp(room.mxid);
				if (opClient) {
					// alright, let's try to migrate the alias
					const newRoomId = `${teamId}-${room.roomId}`;
					try {
						const oldSuffix = await puppet.namespaceHandler.getSuffix(p.puppetId, room.roomId);
						const newSuffix = await puppet.namespaceHandler.getSuffix(p.puppetId, newRoomId);
						const oldAlias = puppet.AS.getAliasForSuffix(oldSuffix);
						const newAlias = puppet.AS.getAliasForSuffix(newSuffix);
						await opClient.deleteRoomAlias(oldAlias);
						await opClient.createRoomAlias(newAlias, room.mxid);
						const prevCanonicalAlias = await opClient.getRoomStateEvent(room.mxid, "m.room.canonical_alias", "");
						if (prevCanonicalAlias && prevCanonicalAlias.alias === oldAlias) {
							prevCanonicalAlias.alias = newAlias;
							await opClient.sendStateEvent(room.mxid, "m.room.canonical_alias", "", prevCanonicalAlias);
						}
					} catch (err) {
						log.verbose("No alias found, ignoring", err.error || err.body || err);
					}
					// let's update the db
					try {
						await store.db.Run("UPDATE chan_store SET room_id = $rid WHERE mxid = $mxid", {
							rid: newRoomId,
							mxid: room.mxid,
						});
					} catch (err) {
						await store.db.Run("UPDATE room_store SET room_id = $rid WHERE mxid = $mxid", {
							rid: newRoomId,
							mxid: room.mxid,
						});
					}
					// let's try to give OP
					try {
						const oldUserId = await opClient.getUserId();
						const userParts = puppet.userSync.getPartsFromMxid(oldUserId);
						if (!userParts) {
							throw new Error("Non-ghost OP");
						}
						userParts.userId = `${teamId}-${userParts.userId}`;
						const newOpSuffix = await puppet.namespaceHandler.getSuffix(p.puppetId, userParts.userId);
						const newOpIntent = puppet.AS.getIntentForSuffix(newOpSuffix);
						// we also want to populate avatar and stuffs
						await puppet.userSync.getClient(userParts);
						await newOpIntent.ensureRegisteredAndJoined(room.mxid);
						await opClient.setUserPowerLevel(newOpIntent.userId, room.mxid, LEVEL_OP);
						await store.roomStore.setRoomOp(room.mxid, newOpIntent.userId);
					} catch (err) {
						log.warn(`Failed to give out OP for ${room.mxid}`, err.error || err.body || err);
					}
					// aaaand time to leave all the old clients
					const ghosts = await puppet.puppetStore.getGhostsInRoom(room.mxid);
					for (const ghost of ghosts) {
						const ghostParts = puppet.userSync.getPartsFromMxid(ghost);
						if (!ghostParts || ghostParts.userId.startsWith(teamId)) {
							continue;
						}
						// tslint:disable-next-line no-floating-promises
						(async () => {
							await Util.sleep(delay);
							log.verbose(`Removing ghost ${ghost} from room ${room.mxid}`);
							try {
								await puppet.userSync.deleteForMxid(ghost);
							} catch (err) {
								log.warn("Couldn't delete user", err.error || err.body || err);
							}
							const intent = puppet.AS.getIntentForUserId(ghost);
							if (intent) {
								try {
									await intent.leaveRoom(room.mxid);
								} catch (err) {
									log.warn("Failed to trigger client leave room", err.error || err.body || err);
								}
							}
						})();
						delay += puppet.config.limits.roomUserAutojoinDelay;
					}
				}
			}
		}
		await store.createTable(`
			CREATE TABLE slack_schema (
				version	INTEGER UNIQUE NOT NULL
			);`, "slack_schema");
		await store.db.Exec("INSERT INTO slack_schema VALUES (0);");
		await store.createTable(`
			CREATE TABLE slack_tokenstore (
				puppet_id INTEGER NOT NULL,
				token TEXT NOT NULL,
				team_id TEXT NOT NULL,
				user_id TEXT NOT NULL
			);`, "slack_tokenstore");
	}
	public async rollBack(store: Store) {
		await store.db.Exec("DROP TABLE IF EXISTS slack_tokenstore");
	}
}
