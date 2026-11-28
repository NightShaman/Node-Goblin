using System.Reflection;

[assembly: AssemblyTitle("Node Goblin")]
[assembly: AssemblyProduct("Node Goblin")]
[assembly: AssemblyDescription("Burrow Windows gateway manager")]
[assembly: AssemblyVersion("1.0.0.0")]
#if !NODE_GOBLIN_RELEASE
[assembly: AssemblyInformationalVersion("development")]
#endif
// Release builds define NODE_GOBLIN_RELEASE and supply a generated
// AssemblyInformationalVersion attribute containing the full calendar stamp.
