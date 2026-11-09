import RobotApp from "./robot-app";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Sphero BOLT コントローラー（プロトタイプ）</h1>
        <p className="text-sm text-zinc-500">
          Web Bluetooth で BOLT に直接接続します。PC 版の Chrome / Edge で使ってください。
        </p>
      </header>
      <RobotApp />
    </main>
  );
}
