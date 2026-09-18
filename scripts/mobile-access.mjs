import os from "node:os";

const port=process.env.PORT||"3000";
const addresses=Object.values(os.networkInterfaces())
 .flat()
 .filter(Boolean)
 .filter(item=>item.family==="IPv4"&&!item.internal)
 .map(item=>item.address);

console.log("\n手机访问地址（手机与电脑需连接同一 Wi-Fi）：");
if(!addresses.length){
 console.log("未找到局域网 IPv4 地址，请在 Windows 设置中查看当前网络地址。");
}else{
 for(const address of [...new Set(addresses)])console.log(`  http://${address}:${port}/matches`);
}
console.log("\n桌面手机预览：");
console.log(`  http://localhost:${port}/mobile-preview\n`);
