"""
agents/mcp_client.py

Industrial-grade MCP session manager.
Manages persistent stdio connections to multiple MCP servers and exposes a
single call_tool() convenience method for use by any bot instance.
"""

import os
import shutil
import logging
import asyncio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.sse import sse_client
from contextlib import AsyncExitStack


class _InitializedNotificationFilter(logging.Filter):
    """Filter out known non-fatal MCP notification validation noise."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        if "Failed to validate notification" in message and "notifications/initialized" in message:
            return False
        return True


# Keep warning logs, but remove this one high-volume known-benign case.
logging.getLogger().addFilter(_InitializedNotificationFilter())



class MultiMCPClient:
    def __init__(self):
        self.sessions: dict[str, ClientSession] = {}
        self.exit_stack = AsyncExitStack()

    @staticmethod
    def expected_default_session_env(name: str) -> str:
        return {
            "solana": "SOLANA_MCP_SSE_URL",
            "jupiter": "JUPITER_MCP_SSE_URL",
            "goldrush": "GOLDRUSH_MCP_SSE_URL",
            "dodo": "DODO_MCP_SSE_URL",
            "umbra": "UMBRA_MCP_SSE_URL",
        }.get(name, f"{name.upper()}_MCP_SSE_URL")

    def connection_diagnostics(self) -> list[str]:
        diagnostics = []
        for name in ("solana", "jupiter", "goldrush", "dodo", "umbra"):
            env_name = self.expected_default_session_env(name)
            env_value = os.environ.get(env_name, "").strip()
            if name in self.sessions:
                diagnostics.append(f"{name}: connected ({env_name} set={bool(env_value)})")
            elif env_value:
                diagnostics.append(f"{name}: not connected ({env_name} is set but session failed to initialize)")
            else:
                diagnostics.append(f"{name}: not connected ({env_name} is missing)")
        return diagnostics

    async def connect_to_server(
        self,
        name: str,
        command: str,
        args: list,
        custom_env: dict = None,
    ):
        """
        Connect to a single MCP server via stdio and register it by name.

        Args:
            name:       Logical server name, e.g. "solana"
            command:    Executable to launch, e.g. "npx"
            args:       CLI arguments list
            custom_env: Extra environment variables to inject (API keys, RPC URLs, etc.)

        Raises:
            RuntimeError: If the command binary is not found in PATH.
        """
        cmd_path = shutil.which(command)
        if not cmd_path:
            raise RuntimeError(
                f"Command '{command}' not found in system PATH. "
                "Ensure Node.js / npx is installed."
            )

        env = os.environ.copy()
        if custom_env:
            env.update(custom_env)

        server_params = StdioServerParameters(
            command=cmd_path,
            args=args,
            env=env,
        )
        print(f"Starting {name} MCP server...")
        transport = await self.exit_stack.enter_async_context(
            stdio_client(server_params)
        )
        read_stream, write_stream = transport
        session = await self.exit_stack.enter_async_context(
            ClientSession(read_stream, write_stream)
        )
        await session.initialize()
        self.sessions[name] = session
        print(f"✅ Connected to '{name}' MCP server")

    async def connect_to_sse_server(self, name: str, url: str, headers: dict = None):
        """Connect directly to a cloud MCP server via SSE, bypassing local node wrappers."""
        transport = await self.exit_stack.enter_async_context(
            sse_client(url=url, headers=headers or {})
        )
        read_stream, write_stream = transport
        session = await self.exit_stack.enter_async_context(
            ClientSession(read_stream, write_stream)
        )
        await session.initialize()
        self.sessions[name] = session
        print(f"✅ Connected to '{name}' MCP server (via Direct SSE)")

    async def list_all_tools(
        self,
        servers: list[str] | None = None,
        timeout_seconds: float = 4.0,
    ) -> list[dict]:
        """Return aggregated tool definitions from connected servers, skipping slow/unhealthy sessions."""
        all_tools = []
        server_filter = set(servers) if servers else None

        for server_name, session in self.sessions.items():
            if server_filter and server_name not in server_filter:
                continue
            try:
                result = await asyncio.wait_for(
                    session.list_tools(),
                    timeout=timeout_seconds,
                )
            except Exception as exc:
                print(f"⚠️  Skipping tool discovery for '{server_name}' ({exc})")
                continue
            for tool in result.tools:
                all_tools.append({
                    "server":       server_name,
                    "name":         tool.name,
                    "description":  tool.description,
                    "input_schema": tool.inputSchema,
                })
        return all_tools

    async def call_tool(self, server: str, tool: str, args: dict) -> str:
        """
        Call a tool on a named MCP server and return the raw text response.

        Args:
            server: Registered server name, e.g. "solana"
            tool:   Tool name, e.g. "move_view"
            args:   Arguments dict

        Returns:
            Raw text string from the MCP response (typically JSON).

        Raises:
            ValueError: If the server is not connected or returns empty content.
        """
        import asyncio
        session = self.sessions.get(server)
        if not session:
            raise ValueError(
                f"MCP server '{server}' is not connected. "
                f"Connected servers: {list(self.sessions.keys())}"
            )

        try:
            # Wait maximum 10 seconds for the MCP to respond
            result = await asyncio.wait_for(session.call_tool(tool, args), timeout=10.0)
        except asyncio.TimeoutError:
            raise ValueError(f"MCP server '{server}' timed out. The connection might be dead.")

        if not result.content:
            raise ValueError(
                f"Server '{server}' / tool '{tool}' returned empty content."
            )

        return result.content[0].text

    async def shutdown(self):
        """Close all sessions cleanly. Always call this on bot exit."""
        try:
            await self.exit_stack.aclose()
        except BaseException as exc:
            # Some stdio transports can raise during forced teardown; log and continue.
            print(f"⚠️  MCP shutdown completed with non-fatal errors: {exc}")
        print("🔒 All MCP sessions closed.")

    async def connect_default_sessions(self):
        """Best-effort registration for commonly used MCP endpoints in Synth."""
        sse_targets = [
            ("solana", os.environ.get("SOLANA_MCP_SSE_URL", "").strip()),
            ("jupiter", os.environ.get("JUPITER_MCP_SSE_URL", "").strip()),
            ("goldrush", os.environ.get("GOLDRUSH_MCP_SSE_URL", "").strip()),
            ("dodo", os.environ.get("DODO_MCP_SSE_URL", "").strip()),
            ("umbra", os.environ.get("UMBRA_MCP_SSE_URL", "").strip()),
        ]
        for name, url in sse_targets:
            if not url:
                continue
            try:
                await self.connect_to_sse_server(name=name, url=url)
            except Exception as exc:
                print(f"⚠️  Failed to connect default MCP session '{name}': {exc}")