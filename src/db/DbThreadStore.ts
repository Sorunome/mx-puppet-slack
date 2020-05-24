/*
Copyright 2019 mx-puppet-bridge
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/


import {IDatabaseConnector} from "mx-puppet-bridge/lib/src/db/connector";
import {Log} from "mx-puppet-bridge/lib/src";

const log = new Log("DbThreadStore");

export class DbThreadStore {
    constructor(
        private db: IDatabaseConnector,
    ) {
    }

    public async setFirstThreadEvent(eventId: string, firstThreadEvent: string) {
        let query: string;
        if (this.db.type == "postgres") {
            query = `INSERT INTO thread_store 
                                (event_id, thread_first_event_id) 
                            VALUES (
                                    $eventId, 
                                    $first
                                )   
                            ON CONFLICT (event_id) DO UPDATE
                                SET thread_first_event_id = $first`;
        } else {
            query = `REPLACE INTO thread_store 
                                (event_id, thread_first_event_id, thread_last_event_id) 
                                VALUES (
                                    $eventId, 
                                    $first, 
                                    SELECT thread_last_event_id FROM thread_store WHERE event_id = $eventId
                                )`;
        }

        await this.db.Run(query, {
            eventId: eventId,
            first: firstThreadEvent
        });
    }

    public async setLastThreadEvent(eventId: string, lastThreadEvent: string) {
        let query: string;
        if (this.db.type == "postgres") {
            query = `INSERT INTO thread_store 
                                (event_id, thread_last_event_id) 
                            VALUES (
                                    $eventId, 
                                    $last
                                )   
                            ON CONFLICT (event_id) DO UPDATE
                                SET thread_last_event_id = $last`;
        } else {
            query = `REPLACE INTO thread_store 
                                (event_id, thread_first_event_id, thread_last_event_id) 
                                VALUES (
                                    $eventId, 
                                    SELECT thread_first_event_id FROM thread_store WHERE event_id = $eventId
                                    $last, 
                                )`;
        }

        await this.db.Run(query, {
            eventId: eventId,
            last: lastThreadEvent
        });
    }

    public async getFirstThreadEvent(eventId: string): Promise<string | undefined> {
        let lastDefinedEventId: string | undefined = undefined;
        let nextEventId: string | undefined = eventId;

        do {
            const result = await this.db.Get("SELECT thread_first_event_id FROM thread_store WHERE event_id = $eventId", {
                eventId: nextEventId
            });
            nextEventId = result?.thread_first_event_id as string | undefined;

            if (nextEventId) {
                lastDefinedEventId = nextEventId;
            }
        } while (nextEventId);

        return lastDefinedEventId;
    }

    public async getLastThreadEvent(eventId: string): Promise<string | undefined> {
        let lastDefinedEventId: string | undefined = undefined;
        let nextEventId: string | undefined = eventId;

        do {
            const result = await this.db.Get("SELECT thread_last_event_id FROM thread_store WHERE event_id = $eventId", {
                eventId: nextEventId
            })
            nextEventId = result?.thread_last_event_id as string | undefined;

            if (nextEventId) {
                lastDefinedEventId = nextEventId;
            }
        } while (nextEventId);

        return lastDefinedEventId;
    }

    public async remove(eventId: string) {
        await this.db.Run("DELETE FROM thread_store WHERE event_id = $eventId OR thread_first_event_id = $eventId", {
            eventId: eventId
        });
    }
}
