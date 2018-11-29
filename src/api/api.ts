/**
 * This file stores API for making request to CompassQL (either within the browser or via the server).
 */

import {Query} from 'compassql/build/src/query/query';
import {recommend} from 'compassql/build/src/recommend';
import {build as buildSchema, Schema} from 'compassql/build/src/schema';
import 'isomorphic-fetch';
import {Data, InlineData} from 'vega-lite/build/src/data';
import {VoyagerConfig} from '../models/config';
import {fromSpecQueryModelGroup, ResultPlotWithKey} from '../models/result';

export {Query, Schema, Data};

/**
 * Submit recommendation query request from CompassQL
 */
export function fetchCompassQLRecommend(query: Query, schema: Schema, data: InlineData, 
    config?: VoyagerConfig, name?: string):
  Promise<ResultPlotWithKey[]> {

  if (config && config.serverUrl) {
    const endpoint = "recommend";

    return fetch(`${config.serverUrl}/${endpoint}` , {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      credentials: "same-origin",
      body: JSON.stringify({
        query,
        // fieldSchemas are just JSON
        schema: schema.fieldSchemas,
        data
      })
    }).then(
      response => {
        return response.json();
      }
    );
  } else {
    return new Promise(resolve => {
      const modelGroup = recommend(query, schema).result;

      // TODO:
      // - replace this with different cached data source's unique names
      // once we have multiple cached data source from Leilani's optimizer engine
      resolve(fromSpecQueryModelGroup(modelGroup, {name: name}));
    });
  }
}

function doInsertSqlHelper(data: Object[], rowsPerChunk: number, startOffset: number, 
  config: VoyagerConfig, name: string): Promise<Response> {
  // Recursively send chunks of data to create the PostgreSQL table.
   
  const endOffset = Math.min(startOffset + rowsPerChunk, data.length);
  console.log("doInsertSqlHelper: sending rows [" + startOffset + ", " + endOffset + ")");
  const chunk = data.slice(startOffset, endOffset);
  const endpoint = "insertSql";
  const promise = fetch(`${config.serverUrl}/${endpoint}`, {
    // FixMe: if there are network issues, it is possible for this 
    // request to be sent twice. This will result in duplicate entries,
    // which is bad.  
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    credentials: "same-origin",
    body: JSON.stringify({
      data: chunk,
      name: name
    })
  });

  if(endOffset < data.length) {
    // Recursive case -- there's more data to send.
    return promise
    .then(
      () => {
        return doInsertSqlHelper(data, rowsPerChunk, endOffset, config, name);
      }
    );
  } else {
    // Base case -- no more data to send.
    return promise;
  }
}

function doInsertSql(data: Object[], config: VoyagerConfig, name: string): Promise<Response> {
  const chunkBytes: number = 10*1024*1024; // 10MB
  const rowBytesSample: number = data.length > 0 ? JSON.stringify(data[0]).length : 1;
  const rowsPerChunk: number = Math.floor(chunkBytes/rowBytesSample);
  console.log("doInsertSql: approx row size (bytes): ", rowBytesSample);
  return doInsertSqlHelper(data, rowsPerChunk, 0, config, name);
}

/**
 * Create PostgreSQL table.
 */
export function doCreateSql(sample: any, config: VoyagerConfig, name: string): Promise<Response> {
  const endpoint = "createSql";
  return fetch(`${config.serverUrl}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    credentials: "same-origin",
    body: JSON.stringify({
      data: sample,
      name: name
    })
  });
}

/**
 * Check if PostgreSQL table exists.
 */ 
export function doCheckExistsSql(config: VoyagerConfig, name: string): Promise<Response> {
  const endpoint = "checkExistsSql";
  return fetch(`${config.serverUrl}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    credentials: "same-origin",
    body: JSON.stringify({
      name: name
    })
  });
}

/**
 * Submit data in chunks to create PostgreSQL table and then submit schema building 
 * request from CompassQL
 */
export function fetchCompassQLBuildSchema(data: Object[], config?: VoyagerConfig, name?: string):
  Promise<Schema> {
  if(config && config.serverUrl) {
    let fetchSchema = function(): Promise<Response> {
      // Here we actually fetch the schema
      const endpoint = "build";
      return fetch(`${config.serverUrl}/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        credentials: "same-origin",
        body: JSON.stringify({
          name: name
        })
      });
    }
    // FixMe: check error statuses.
    // FixMe: empty data + non-existing table case will cause fetchSchema() 
    // to fail on the server. 
    if(data.length === 0) {
      // Table already exists or data is empty, so don't create/insert into table.
      return fetchSchema()
      .then(response => response.json())
      .then(fields => new Schema({fields: fields.fields}));
    } else {
      // Table doesn't exist yet. So create/insert into table.
      return doCreateSql(data[0], config, name)
      .then(() => doInsertSql(data, config, name))
      .then(fetchSchema)
      .then(response => response.json())
      .then(fields => new Schema({fields: fields.fields}));
    }
  } else {
    return new Promise(resolve => {
      resolve(buildSchema(data));
    });
  }
}

/**
 * Submit vega query
 */
export function doVegaQuery(data: any, config?: VoyagerConfig):
  Promise<any> {
  if (config && config.serverUrl) {
    const endpoint = "querySql";
    return fetch(`${config.serverUrl}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      credentials: "same-origin",
      body: JSON.stringify({
        data
      })
    }).then(
      response => {
        return response.json();
      }
    );
  } else {
    console.log("WARNING: /querySql route only available in server mode");
  }
}
