import asyncio
import json
import os
from pathlib import Path

import psycopg
from harnesslab_contracts.validate import accepts, definition
from mcp import types
from mcp.server import Server
from mcp.server.stdio import stdio_server

from .sql_policy import QueryRejected
from .tools import MAX_RESPONSE_BYTES, Tools, json_bytes, postgres_error

TOOL_ARGS = {
    "list_tables": "ListTablesArgs",
    "describe_schema": "DescribeSchemaArgs",
    "execute_readonly_sql": "ExecuteReadonlySqlArgs",
    "get_business_definition": "GetBusinessDefinitionArgs",
    "validate_calculation": "ValidateCalculationArgs",
    "inspect_query_error": "InspectQueryErrorArgs",
}


def make_server(tools: Tools) -> Server:
    if set(TOOL_ARGS) != set(definition("ToolName")["enum"]):
        raise RuntimeError("Tool registry mismatch")
    server = Server("dataops-mcp-v1", instructions=json.dumps(tools.list_tables()))

    @server.list_tools()
    async def list_tools():
        return [
            types.Tool(name=name, inputSchema=definition(args)) for name, args in TOOL_ARGS.items()
        ]

    @server.call_tool(validate_input=False)
    async def call_tool(name: str, arguments: dict):
        if name not in TOOL_ARGS:
            return types.CallToolResult(isError=True, content=[])
        if not accepts(TOOL_ARGS[name], arguments):
            result = tools.error(name, "malformed_call")
        else:
            try:
                data = getattr(tools, name)(**arguments)
                if data == {"injected_malformed_result": True}:
                    return types.CallToolResult(content=[], structuredContent=data)
                result = {"status": "ok", "name": name, "data": data}
                if (
                    not accepts("ToolResult", result)
                    or len(json_bytes(result)) > MAX_RESPONSE_BYTES
                ):
                    result = tools.error(name, "unsupported_value")
            except QueryRejected as exc:
                result = tools.error(name, exc.code)
            except psycopg.Error as exc:
                result = tools.error(name, postgres_error(exc))
            except Exception:
                result = tools.error(name, "sandbox_unavailable")
        return types.CallToolResult(content=[], structuredContent=result)

    return server


async def main():
    fault = json.loads(os.environ.get("HL_MCP_FAULT", "null"))
    if fault is not None and not accepts("FaultFixture", fault):
        raise ValueError("Invalid fault")
    catalog = json.loads(Path(os.environ["HL_MCP_CATALOG"]).read_text(encoding="utf-8"))
    with psycopg.connect(os.environ["HL_MCP_DSN"], connect_timeout=4, autocommit=True) as conn:
        tools = Tools(conn, os.environ["HL_MCP_SCHEMA"], os.environ["HL_MCP_ROLE"], catalog, fault)
        server = make_server(tools)
        async with stdio_server() as (reader, writer):
            await server.run(reader, writer, server.create_initialization_options())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        raise SystemExit("MCP startup or transport failed") from None
