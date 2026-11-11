const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 18)) {
  console.error(`\nJarvis Professor precisa do Node 22.18 ou mais novo. Você está no ${process.versions.node}.`);
  console.error('Atualize com: brew install node   (ou: nvm install 22)\n');
  process.exit(1);
}
