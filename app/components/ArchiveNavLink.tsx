export default function ArchiveNavLink({active=false}:{active?:boolean}){
  return <a className={active?"active":undefined} aria-current={active?"page":undefined} href="/prediction-archive"><span aria-hidden="true">▤</span><b>盘后回溯</b></a>;
}
