import {
  SqlQuery,
  DatasourcePlus,
  ConnectionInfo,
  Schema,
  Table,
  DatasourcePlusQueryResponse,
  QueryJson,
  EnrichedQueryJson,
  TableSourceType,
  FieldType,
  FieldSchema,
  TableSchema,
  Row,
} from "@budibase/types";
import { Surreal, StringRecordId } from "surrealdb";

interface SurrealConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  namespace: string;
  database: string;
}

interface SurrelFieldSchema {
  name: string;
  kind: string;
  assert: string | void;
}
interface SurrealRow {
  [key: string]: any;
}

const fieldKindMap: { [key: string]: any } = {
  any: FieldType.STRING,
  string: FieldType.STRING,
  number: FieldType.NUMBER,
  datetime: FieldType.DATETIME,
  bool: FieldType.BOOLEAN,
  object: FieldType.JSON,
  "array<string>": FieldType.ARRAY,
};
export function buildExternalTableId(datasourceId: string, tableName: string) {
  // encode spaces
  if (tableName.includes(" ")) {
    tableName = encodeURIComponent(tableName);
  }
  return `${datasourceId}${"__"}${tableName}`;
}

class SurrealIntegration implements DatasourcePlus {
  private readonly config: SurrealConfig;
  private readonly db: Surreal;
  private open: boolean = false;

  constructor(config: SurrealConfig) {
    this.config = config;
    this.db = new Surreal();
    this.useDb();
  }

  getBindingIdentifier(): string {
    return "$var";
  }

  getStringConcat(parts: string[]): string {
    return `concat(${parts.join(", ")})`;
  }

  async testConnection(): Promise<ConnectionInfo> {
    const response: ConnectionInfo = {
      connected: true,
    };

    try {
      await this.db.connect(`${this.config.host}:${this.config.port}/rpc`, {
        namespace: this.config.namespace,
        database: this.config.database,
        auth: {
          username: this.config.username,
          password: this.config.password,
        },
      });
      response.connected = true;
    } catch (ex: any) {
      response.connected = false;
      response.error = ex.message;
    }

    return response;
  }

  async useDb() {
    if (this.open) return;
    try {
      await this.db.connect(`${this.config.host}:${this.config.port}/rpc`, {
        namespace: this.config.namespace,
        database: this.config.database,
        auth: {
          username: this.config.username,
          password: this.config.password,
        },
      });
      this.open = true;
    } catch (err) {
      console.error(
        "Failed to connect to SurrealDB:",
        err instanceof Error ? err.message : String(err)
      );
      await this.db.close();
      throw err;
    }
  }

  async getSchema() {
    await this.useDb();
    const [schema] = await this.db.query("INFO FOR DB Structure");
    return schema;
  }

  async getTableNames() {
    await this.useDb();
    const res: any = await this.db.query("INFO FOR DB Structure");
    return res[0].tables.map((x: any) => x.name);
  }

  async query(json: EnrichedQueryJson): Promise<DatasourcePlusQueryResponse> {
    await this.useDb();
    if (json.operation == "UPDATE_TABLE") {
      return;
    }

    if (json.operation == "CREATE_TABLE") {
      return;
    }
    if (json.operation == "DELETE_TABLE") {
      return;
    }

    if (json.operation == "READ") {
      // If targeting specific record
      if (json.extra?.idFilter?.equal?.id)
        return [
          await this.db.select(
            new StringRecordId(json.extra?.idFilter?.equal?.id)
          ),
        ];
      // Complex Queries
      else {
        return await this.db.select(json.table.name);
      }
    }

    if (json.operation == "CREATE") {
      let schema: TableSchema = json.table.schema;
      let row: Row = this.toSurrealRow(schema, json.body);
      return await this.db.insert(json.table.name, row);
    }

    if (json.operation == "UPDATE") {
      let id = new StringRecordId(json.filters?.equal?.id);
      let schema: TableSchema = json.table.schema;
      let row: Row = this.toSurrealRow(schema, json.body);

      let updated = await this.db.update(id, row);

      return [this.toBudibaseRow(schema, updated)];
    }

    if (json.operation == "DELETE") {
      let id = new StringRecordId(json.extra?.idFilter?.equal?.id);
      await this.db.delete(id);
      return [];
    }
  }

  //
  async buildSchema(
    datasourceId: string,
    entities: Record<string, Table>
  ): Promise<Schema> {
    // Make sure we have a connection to the DB
    await this.useDb();
    let tables: { [key: string]: Table } = {};

    // Get the list of tables
    let [db]: any[] = await this.db.query("INFO FOR DB");

    for (const table in db.tables) {
      const [tableSchema]: any[] = await this.db.query(
        "INFO FOR TABLE " + table + " STRUCTURE"
      );
      tables[table] = {
        _id: buildExternalTableId(datasourceId, table),
        name: table,
        type: "table",
        primary: ["id"],
        schema: this.toBudibaseTable(tableSchema["fields"]),
        sourceId: datasourceId,
        sourceType: TableSourceType.EXTERNAL,
      };
    }
    return { tables: tables, errors: {} };
  }

  // From Surreal To Budibase conversion
  toBudibaseRow(table: TableSchema, row: Row): Row {
    return row;
  }

  toBudibaseField(field: SurrelFieldSchema): FieldSchema {
    return {
      name: field.name,
      type: field.kind.includes("|")
        ? FieldType.OPTIONS
        : fieldKindMap[field.kind ?? "string"],
      externalType: field.kind ?? "string",
      constraints: {
        presence: !field.kind.startsWith("option") && field.kind != "bool",
        inclusion: field.kind.includes("|")
          ? field.kind
              .replace("option<", "")
              .replace(">", "")
              .replace(/["']/g, "")
              .split("|")
              .map((x) => x.trim())
          : undefined,
      },
    };
  }

  toBudibaseTable(fields: any): TableSchema {
    let schema: TableSchema = {};

    // Create default id field
    let id: FieldSchema = {
      name: "id",
      autocolumn: true,
      type: FieldType.STRING,
      order: 0,
      visible: false,
    };

    // Add default id column
    schema[id.name] = id;

    // Create rest of fields
    fields.forEach((field: SurrelFieldSchema) => {
      schema[field.name] = this.toBudibaseField(field);
    });

    return schema;
  }

  // From Budibase To Surreal conversion
  toSurrealRow(tableSchema: TableSchema, rowValues: Row | undefined): Row {
    if (rowValues) {
      let richRow: Row = {};

      for (const field in tableSchema) {
        if (field != "id")
          if (tableSchema[field].type == FieldType.DATETIME)
            richRow[field] = new Date(rowValues[field]);
          else if (tableSchema[field].type == FieldType.BOOLEAN)
            richRow[field] = rowValues[field] ?? false;
          else richRow[field] = rowValues[field];
      }

      return richRow;
    } else return {};
  }

  // Handling of Queries
  async create(query: SqlQuery) {
    await this.useDb();
    return await this.db.query(query.sql);
  }

  async read(query: SqlQuery) {
    await this.useDb();
    return await this.db.query(query.sql);
  }

  async readOne(query: { id: "string" }) {
    await this.useDb();
    return await this.db.select(new StringRecordId(query.id));
  }

  async update(query: SqlQuery) {
    await this.useDb();
    return await this.db.query(query.sql);
  }

  async delete(query: SqlQuery) {
    await this.useDb();
    return await this.db.query(query.sql);
  }

  async sql(query: SqlQuery) {
    await this.useDb();
    let enrichedQuery = query.sql.toString();
    if (query.bindings) {
      for (let i = 0; i < query.bindings?.length; i++) {
        let binding = query.bindings[i] ?? "";
        enrichedQuery = enrichedQuery.replace("$var", "'" + binding + "'");
      }
    }
    return await this.db.query(enrichedQuery);
  }
}

export default SurrealIntegration;
