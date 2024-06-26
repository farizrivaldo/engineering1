import React from "react";
import {
  Tabs,
  TabList,
  TabPanels,
  Tab,
  TabPanel,
  Card,
  CardBody,
} from "@chakra-ui/react";
import PowerManagement from "./PowerManagement";
import PowerManagement2 from "./PowerManagement1";
import HVAC from "./HVAC";
import Water from "./Water";
import PurifiedControl from "./PurifiedControl";
import Loopo from "./Loopo";
import Osmotron from "./Osmotron";
import AlarmList from "./AlarmList";

function Utility() {
  return (
    <div>
      <Card>
        <CardBody>
          <Tabs isFitted size={"lg"} variant="enclosed" class=" p-3  ">
            <TabList>
              <Tab>Power Management</Tab>
              <Tab>Power Management 2</Tab>
              <Tab>Water Management</Tab>
              <Tab>Waste Water Management</Tab>
              <Tab>Heating Ventilating & Air Control</Tab>
              <Tab>Steam Control</Tab>
              <Tab>Solar Management</Tab>
              <Tab>Loopo</Tab>
              <Tab>Osmotron</Tab>
              <Tab>Alarm List</Tab>
            </TabList>

            <TabPanels>
              <TabPanel>
                <PowerManagement />
              </TabPanel>
              <TabPanel>
                <PowerManagement2 />
              </TabPanel>
              <TabPanel>
                <Water />
              </TabPanel>
              <TabPanel>
                <p>Waste Water Management</p>
              </TabPanel>
              <TabPanel>
                <HVAC />
              </TabPanel>
              <TabPanel>
                <p>Steam Control</p>
              </TabPanel>
              <TabPanel>
                <p>Solar Management</p>
              </TabPanel>
              <TabPanel>
                <Loopo />
              </TabPanel>
              <TabPanel>
                <Osmotron/>
              </TabPanel>
              <TabPanel>
                <AlarmList/>
              </TabPanel>
            </TabPanels>
          </Tabs>
        </CardBody>
      </Card>
    </div>
  );
}

export default Utility;
