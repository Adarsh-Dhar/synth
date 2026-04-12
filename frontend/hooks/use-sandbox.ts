import { useState, useRef, useEffect } from "react";
import { parseFilesToTree } from "@/lib/utils";
import { ENTRY_POINTS, NPMRC_CONTENT, TOKEN_ADDRESSES } from "@/lib/constant";
import { Phase, EnvConfig, GeneratedFile } from "@/lib/types";

let globalWebContainerInstance: any = null;

export function useSandbox({ generatedFiles, envConfig, termRef }: {
  generatedFiles: GeneratedFile[];
  envConfig: EnvConfig;
  termRef: React.MutableRefObject<any>;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("Idle");
  const webcontainerRef = useRef<unknown>(null);
  
  // ✅ ADDED: Track the active running process so we can kill it
  const activeProcessRef = useRef<any>(null);

  useEffect(() => {
    if (generatedFiles.length > 0 && phase === "idle") {
      setPhase("env-setup");
    }
  }, [generatedFiles, phase]);

  const bootAndRun = async () => {
    const term = termRef.current;
    if (!term) return;
    
    setPhase("running");
    setStatus("Booting sandbox...");
    term.writeln("\x1b[36m[System]\x1b[0m Injecting environment and booting WebContainer...");
    
    try {
      if (!(envConfig.SOLANA_RPC_URL || envConfig.SOLANA_RPC_URL) || !envConfig.CONTRACT_ADDRESS) {
        term.writeln("\x1b[31m[Error]\x1b[0m Please fill in the RPC URL and Contract Address.");
        setPhase("env-setup");
        return;
      }
      
      let resolvedKey = "";
      if (envConfig.SOLANA_KEY && String(envConfig.SOLANA_KEY).trim()) {
        resolvedKey = String(envConfig.SOLANA_KEY).trim();
      } else if (envConfig.SOLANA_KEY && /^[0-9a-fA-F]{64}$/.test(String(envConfig.SOLANA_KEY).replace("0x", ""))) {
        resolvedKey = String(envConfig.SOLANA_KEY).trim();
      } else {
        resolvedKey = "0000000000000000000000000000000000000000000000000000000000000000";
      }

      const envContent = [
        `DRY_RUN=${envConfig.DRY_RUN}`,
        `SOLANA_RPC_URL=${envConfig.SOLANA_RPC_URL ?? envConfig.SOLANA_RPC_URL}`,
        `SOLANA_RPC_URL=${envConfig.SOLANA_RPC_URL ?? envConfig.SOLANA_RPC_URL}`,
        `SOLANA_KEY=${resolvedKey}`,
        `SOLANA_KEY=${resolvedKey}`,
        `CONTRACT_ADDRESS=${envConfig.CONTRACT_ADDRESS}`,
        `MAX_LOAN_USD=${envConfig.MAX_LOAN_USD}`,
        `MIN_PROFIT_USD=${envConfig.MIN_PROFIT_USD}`,
        `POLL_MS=15000`,
      ].join("\n");
      
      const finalFiles = [
        ...generatedFiles.filter(f => f.filepath !== ".env" && f.filepath !== ".npmrc"),
        { filepath: ".env",   content: envContent },
        { filepath: ".npmrc", content: NPMRC_CONTENT },
      ];
      
      const { WebContainer } = await import("@webcontainer/api");
      if (!globalWebContainerInstance) {
        try {
          globalWebContainerInstance = await Promise.race([
            (WebContainer as { boot: () => Promise<unknown> }).boot(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("WebContainer Boot Timeout")), 15000))
          ]);
        } catch (bootErr: any) {
          if (bootErr?.message?.includes("Only a single WebContainer instance")) {
            throw new Error("WebContainer is already running in the background. Please hard refresh the page (Cmd/Ctrl + R). ");
          }
          throw bootErr;
        }
      }
      
      webcontainerRef.current = globalWebContainerInstance;
      
      await new Promise(r => setTimeout(r, 500));
      const wc = webcontainerRef.current as any;
      
      try {
        await wc.mount(parseFilesToTree(finalFiles));
      } catch (mountErr: any) {
        throw new Error(`Failed to mount files. Details: ${mountErr.message}`);
      }
      
      setStatus("Installing packages...");
      term.writeln("\x1b[36m[System]\x1b[0m npm install --legacy-peer-deps");
      
      const install = await wc.spawn("jsh", ["-c", "npm install --loglevel=error --legacy-peer-deps --no-fund"], {
        env: { npm_config_yes: "true" },
        terminal: { cols: term.cols, rows: term.rows }
      });
      
      const installInput = install.input.getWriter();
      const installHook = term.onData((data: string) => { installInput.write(data).catch(() => {}); });
      install.output.pipeTo(new WritableStream({ write(chunk: any) { term.write(chunk); } }));
      
      const installCode = await install.exit;
      installHook.dispose();
      installInput.releaseLock();

      if (installCode !== 0) {
        setStatus("Install failed");
        term.writeln("\x1b[31m[Error]\x1b[0m npm install failed");
        setPhase("env-setup");
        return;
      }
      
      const processEnv = {
        SOLANA_RPC_URL:   envConfig.SOLANA_RPC_URL ?? envConfig.SOLANA_RPC_URL,
        SOLANA_RPC_URL:   envConfig.SOLANA_RPC_URL ?? envConfig.SOLANA_RPC_URL,
        SOLANA_KEY:       resolvedKey,
        SOLANA_KEY:       resolvedKey,
        CONTRACT_ADDRESS: envConfig.CONTRACT_ADDRESS || "NOT_DEPLOYED_YET",
        MAX_LOAN_USD:     envConfig.MAX_LOAN_USD,
        MIN_PROFIT_USD:   envConfig.MIN_PROFIT_USD,
        ...TOKEN_ADDRESSES,
      };
      
      const actualFiles = finalFiles.map(f => (f.filepath || (f as any).path || "").replace(/^[./]+/, ""));
      const foundEntry = ENTRY_POINTS.find(p => actualFiles.includes(p)) || 
                         actualFiles.find(f => f.endsWith(".ts") && !f.includes("config") && !f.includes("types") && !f.includes("shared")) || 
                         "src/agent/index.ts";
                         
      setStatus("Bot running...");
      term.writeln(`\n\x1b[36m[System]\x1b[0m Detected entry point: \x1b[1m${foundEntry}\x1b[0m`);
      
      // ✅ Track the running bot process
      const run = await wc.spawn("jsh", ["-c", `npx -y tsx ${foundEntry}`], {
        env: processEnv,
        terminal: { cols: term.cols, rows: term.rows }
      });
      activeProcessRef.current = run;
      
      const runInput = run.input.getWriter();
      const runHook = term.onData((data: string) => { runInput.write(data).catch(() => {}); });
      run.output.pipeTo(new WritableStream({ write(chunk: any) { term.write(chunk); } }));
      
      const exitCode = await run.exit;
      activeProcessRef.current = null; // Clear ref on exit
      runHook.dispose();
      runInput.releaseLock();

      // Check if it was killed manually
      if (exitCode !== 0 && exitCode !== 130 && exitCode !== 143) {
         term.writeln(`\n\x1b[31m[Error]\x1b[0m Bot crashed with exit code ${exitCode}`);
         setStatus("Crashed");
      } else {
        term.writeln(`\n\x1b[32m[System]\x1b[0m Bot execution finished.`);
        setStatus("Finished");
      }
      setPhase("env-setup");

    } catch (err: unknown) {
      setStatus("Error");
      term.writeln("\x1b[31m[Error]\x1b[0m " + String(err instanceof Error ? err.message : err));
      setPhase("env-setup");
      activeProcessRef.current = null;
    }
  };

  // ✅ ADDED: Programmatic function to force kill the process
  const stopProcess = () => {
    if (activeProcessRef.current) {
      activeProcessRef.current.kill();
      activeProcessRef.current = null;
      setStatus("Stopped");
      setPhase("env-setup");
      termRef.current?.writeln(`\n\x1b[33m[System]\x1b[0m Bot forcefully stopped by user.`);
    }
  };

  const updateFileInSandbox = async (filepath: string, content: string) => {
    if (webcontainerRef.current) {
      try {
        const safePath = filepath.replace(/^[./]+/, "");
        await (webcontainerRef.current as any).fs.writeFile(safePath, content);
      } catch (err) {
        console.error("Failed to sync file:", err);
      }
    }
  };

  return { bootAndRun, phase, status, setPhase, setStatus, updateFileInSandbox, stopProcess };
}