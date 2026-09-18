export default function ArchiveNavLink({active=false}:{active?:boolean}){
  return <a className={active?"active":undefined} aria-current={active?"page":undefined} href="/prediction-archive">▤ 盘后回溯</a>;
}
