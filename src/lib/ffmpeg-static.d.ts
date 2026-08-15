// ffmpeg-static was removed from dependencies (REQ-07: its postinstall ships
// no Android binary and crashes `npm install` on Termux). The desktop lazy
// import stays, so typecheck needs this ambient declaration.
declare module 'ffmpeg-static' {
  const ffmpegPath: string | null
  export default ffmpegPath
}
