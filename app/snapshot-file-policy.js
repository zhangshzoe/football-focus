export function snapshotIdFromFileName(fileName){
 const matched=String(fileName||"").match(/^(\d{4}-\d{2}-\d{2})_((?:[01]\d|2[0-3])[0-5]\d)(?:\.raw)?\.json$/);
 return matched?`${matched[1]}-${matched[2]}`:"";
}
