import { describe, it, expect } from "vitest";
import { ociLaunchCommand, registryLaunchCommand } from "./launch-command.js";

// Ported from MCP Rating's tests/unit/crawler/launch-command.test.ts, so the two
// implementations are held to the same real declarations.
describe("registryLaunchCommand", () => {
  it("adds the subcommand Scrapling declares (as a positional valueHint)", () => {
    expect(
      registryLaunchCommand({
        registryType: "pypi", identifier: "scrapling", runtimeHint: "uvx",
        packageArguments: [{ type: "positional", valueHint: "mcp" }],
      }),
    ).toBe("uvx scrapling mcp");
  });

  it("puts Serena's misfiled package arguments after the package, keeping uvx's own -p before it", () => {
    expect(
      registryLaunchCommand({
        registryType: "pypi", identifier: "serena-agent", runtimeHint: "uvx",
        runtimeArguments: [
          { type: "named", name: "-p", value: "3.13" },
          { type: "positional", value: "start-mcp-server" },
          { type: "positional", value: "--project-from-cwd" },
          { type: "named", name: "--context", default: "desktop-app" },
        ],
      }),
    ).toBe("uvx -p 3.13 serena-agent start-mcp-server --project-from-cwd --context desktop-app");
  });

  it("keeps npm's plain form, and adds flags (declared as positional values) and fixed values", () => {
    expect(registryLaunchCommand({ registryType: "npm", identifier: "chrome-devtools-mcp" })).toBe("npx chrome-devtools-mcp");
    expect(
      registryLaunchCommand({
        registryType: "npm", identifier: "@x/server", runtimeHint: "npx",
        runtimeArguments: [{ type: "positional", value: "-y" }],
        packageArguments: [{ type: "positional", value: "--stdio" }, { type: "named", name: "--port", value: "3000" }],
      }),
    ).toBe("npx -y @x/server --stdio --port 3000");
  });

  it("leaves out optional arguments the user must supply: placeholders, valueless names, values with spaces", () => {
    expect(
      registryLaunchCommand({
        registryType: "pypi", identifier: "x-mcp",
        packageArguments: [
          { type: "positional", value: "{project_dir}" },
          { type: "named", name: "--account" },
          { type: "named", name: "--api-key", valueHint: "your_key" },
          { type: "named", name: "--title", value: "two words" },
        ],
      }),
    ).toBe("uvx x-mcp");
  });

  it("falls back to the plain command when a required argument needs the user's input", () => {
    // Snowflake: --service-config-file is required and has no value.
    expect(registryLaunchCommand({
      registryType: "pypi", identifier: "snowflake-labs-mcp",
      packageArguments: [{ type: "named", name: "--service-config-file", isRequired: true }, { type: "named", name: "--transport", default: "stdio" }],
    })).toBe("uvx snowflake-labs-mcp");
    // guildcontrol: `serve --config <file>`, the file being the user's.
    expect(registryLaunchCommand({
      registryType: "npm", identifier: "guildctl", runtimeHint: "npx",
      packageArguments: [
        { type: "positional", value: "serve" }, { type: "positional", value: "--config" },
        { type: "positional", valueHint: "config_file", isRequired: true, format: "filepath", placeholder: "/absolute/path/to/guildcontrol.json" },
      ],
    })).toBe("npx guildctl");
    // reasongate: `-- <server_command>`.
    expect(registryLaunchCommand({
      registryType: "pypi", identifier: "reasongate", runtimeHint: "uvx",
      packageArguments: [{ type: "positional", value: "--" }, { type: "positional", valueHint: "server_command", isRequired: true }],
    })).toBe("uvx reasongate");
  });

  it("drops the package when an entry spells it out again among the runtime arguments", () => {
    expect(registryLaunchCommand({
      registryType: "npm", identifier: "orisha-data-mcp", runtimeHint: "npx",
      runtimeArguments: [{ type: "positional", value: "-y" }, { type: "positional", value: "orisha-data-mcp" }],
    })).toBe("npx -y orisha-data-mcp");
    expect(registryLaunchCommand({
      registryType: "npm", identifier: "@m/newrelic-mcp", runtimeHint: "npx",
      runtimeArguments: [{ type: "positional", value: "-y" }, { type: "positional", value: "@m/newrelic-mcp@1.0.0" }],
    })).toBe("npx -y @m/newrelic-mcp");
  });

  it("drops the package when an entry spells it out among the package arguments too", () => {
    expect(registryLaunchCommand({
      registryType: "npm", identifier: "@aipost/mcp-server", runtimeHint: "node",
      packageArguments: [{ type: "positional", value: "-y" }, { type: "positional", value: "@aipost/mcp-server" }, { type: "positional", value: "--stdio" }],
    })).toBe("npx -y @aipost/mcp-server --stdio");
  });

  it("ignores a runtime hint that isn't the package's runner, with its arguments", () => {
    expect(registryLaunchCommand({
      registryType: "pypi", identifier: "acord-bridge-mcp", runtimeHint: "python",
      runtimeArguments: [{ type: "positional", value: "-m" }],
      packageArguments: [{ type: "positional", value: "serve" }],
    })).toBe("uvx acord-bridge-mcp serve");
  });

  it("doesn't repeat the package when the runtime option already names it (npx --package, uvx --from)", () => {
    expect(
      registryLaunchCommand({
        registryType: "npm", identifier: "@clize/inbox", runtimeHint: "npx",
        runtimeArguments: [{ type: "named", name: "--package", value: "@clize/inbox" }],
        packageArguments: [{ type: "positional", value: "clize-mcp" }, { type: "named", name: "--profile", value: "inbox" }],
      }),
    ).toBe("npx --package @clize/inbox clize-mcp --profile inbox");
    expect(
      registryLaunchCommand({
        registryType: "pypi", identifier: "gamewave-unreal-mcp", runtimeHint: "uvx",
        runtimeArguments: [{ type: "named", name: "--from", value: "gamewave-unreal-mcp" }],
        packageArguments: [{ type: "positional", value: "unreal-mcp" }],
      }),
    ).toBe("uvx --from gamewave-unreal-mcp unreal-mcp");
  });

  it("builds nothing for registries it has no runtime for", () => {
    expect(registryLaunchCommand({ registryType: "oci", identifier: "ghcr.io/x/y" })).toBeNull();
  });
});

describe("ociLaunchCommand", () => {
  it("runs the image with stdin open, removed on exit, and each declared variable forwarded by name", () => {
    expect(
      ociLaunchCommand({
        registryType: "oci",
        identifier: "ghcr.io/acme/mcp",
        version: "1.2.0",
        environmentVariables: [{ name: "ACME_TOKEN", isRequired: true, isSecret: true }, { name: "bad name" }],
      }),
    ).toBe("docker run -i --rm -e ACME_TOKEN ghcr.io/acme/mcp:1.2.0");
  });

  it("keeps a tag the identifier already has, and adds fixed arguments", () => {
    expect(
      ociLaunchCommand({
        registryType: "oci",
        identifier: "docker.io/acme/mcp:latest",
        packageArguments: [{ type: "positional", value: "--stdio" }],
      }),
    ).toBe("docker run -i --rm docker.io/acme/mcp:latest --stdio");
  });

  it("is null when a required argument needs the user's input, or for another registry type", () => {
    expect(
      ociLaunchCommand({
        registryType: "oci",
        identifier: "ghcr.io/acme/mcp",
        packageArguments: [{ type: "named", name: "--workspace", isRequired: true }],
      }),
    ).toBeNull();
    expect(ociLaunchCommand({ registryType: "npm", identifier: "x" })).toBeNull();
  });
});
