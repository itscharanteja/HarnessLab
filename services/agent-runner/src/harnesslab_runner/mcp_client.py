import json
import os
import re
import sys
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

from harnesslab_contracts.validate import accepts, definition
from harnesslab_mcp.server import TOOL_ARGS
from harnesslab_mcp.tools import MAX_RESPONSE_BYTES, json_bytes, sql_payload_hash
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def valid_sql_data(data: dict) -> bool:
    columns, rows = data["columns"], data["rows"]
    types = {"integer": int, "boolean": bool}
    if len({column["name"] for column in columns}) != len(columns):
        return False
    for row in rows:
        if len(row) != len(columns):
            return False
        for value, column in zip(row, columns, strict=True):
            kind = column["type"]
            if value is None:
                continue
            if type(value) is not types.get(kind, str):
                return False
            if kind == "decimal" and not re.fullmatch(r"-?(0|[1-9]\d*)(\.\d+)?", value, re.ASCII):
                return False
    return data["payload_hash"] == sql_payload_hash(columns, rows)


@dataclass
class DataOpsSession:
    client: ClientSession
    schema: str
    tables: set[str]

    async def call(self, call: dict) -> dict | None:
        response = await self.client.call_tool(call["name"], call["arguments"])
        result = response.structuredContent
        if (
            response.isError
            or not accepts("ToolResult", result)
            or result["name"] != call["name"]
            or len(json_bytes(result)) > MAX_RESPONSE_BYTES
        ):
            return None
        if result["status"] == "ok" and result["name"] == "execute_readonly_sql":
            if not valid_sql_data(result["data"]):
                return None
        return result


@asynccontextmanager
async def open_dataops(dsn: str, variant: str, catalog: Path, fault: dict | None = None):
    schema = f"hl_{variant}"
    parameters = StdioServerParameters(
        command=sys.executable,
        args=["-m", "harnesslab_mcp.server"],
        env={
            "HL_MCP_DSN": dsn,
            "HL_MCP_SCHEMA": schema,
            "HL_MCP_ROLE": f"hl_read_{variant}",
            "HL_MCP_CATALOG": str(catalog),
            "HL_MCP_FAULT": json.dumps(fault),
        },
    )
    with open(os.devnull, "w", encoding="utf-8") as stderr:
        async with stdio_client(parameters, errlog=stderr) as (read, write):
            async with ClientSession(read, write) as client:
                response = await client.initialize()
                metadata = json.loads(response.instructions or "null")
                tools = await client.list_tools()
                expected = {name: definition(args) for name, args in TOOL_ARGS.items()}
                if (
                    response.serverInfo.name != "dataops-mcp-v1"
                    or not accepts("ListTablesData", metadata)
                    or tools.nextCursor is not None
                    or len(tools.tools) != len(expected)
                    or {tool.name: tool.inputSchema for tool in tools.tools} != expected
                ):
                    raise ValueError("Invalid MCP registry")
                yield DataOpsSession(client, schema, set(metadata["tables"]))
