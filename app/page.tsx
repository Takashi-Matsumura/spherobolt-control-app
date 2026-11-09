import RobotApp from "./robot-app";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">BOLT Pilot</h1>
        <p className="text-sm text-zinc-500">
          Sphero BOLT を、AI の目で自動操縦したり、手で操作したりします。PC 版の Chrome / Edge で使ってください。
        </p>
      </header>
      <RobotApp />
    </main>
  );
}
